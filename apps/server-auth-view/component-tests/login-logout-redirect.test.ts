import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthBootstrapData } from "@frontend-core/auth/types";
import { AuthAPI, apiClient } from "../src/lib/api";
import { useLoginBootstrap } from "../src/composables/useLoginBootstrap";
import { useLoginRedirect } from "../src/composables/useLoginRedirect";
import { canonicalAuthHistoryTarget } from "../src/lib/auth-route-canonicalization";

const wrappers: VueWrapper[] = [];
const target = "https://app.example.com/private?tab=files";
const login = `https://auth.example.com/?logged_out=1&redirect_uri=${encodeURIComponent(target)}#/login`;

beforeEach(() => {
  window.history.replaceState(null, "", "/__auth__/login?logged_out=1");
  window.sessionStorage.clear();
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
});

async function setup(data: Partial<AuthBootstrapData>) {
  const bootstrap: AuthBootstrapData = {
    auth: { authenticated: false, message: "" },
    client: { ip: "203.0.113.1" },
    passkey: { available: false },
    ...data,
  } as AuthBootstrapData;
  const fetchBootstrap = vi
    .spyOn(AuthAPI, "getBootstrap")
    .mockResolvedValue(bootstrap);
  const navigate = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ["/", "/login"].map((path) => ({
      path,
      component: { template: "<div/>" },
    })),
  });
  await router.push("/login");
  let redirect!: ReturnType<typeof useLoginRedirect>;
  const error = vi.fn();
  const probe = defineComponent({
    setup() {
      redirect = useLoginRedirect({ translate: (key) => key });
      useLoginBootstrap({
        ...redirect,
        applyAuthSystemConfig: async () => {},
        captchaConfig: ref(null),
        isCaptchaConfigLoading: ref(true),
        isPasskeyAvailable: ref(false),
        ldapProviderId: ref(""),
        ldapProviders: ref([]),
        loginMode: ref("totp"),
        oidcError: ref(""),
        oidcProviders: ref([]),
        refreshBrowserCapabilities: () => {},
        reportError: error,
        startLocationPolling: () => {},
        translate: (key) => key,
      });
      return () => null;
    },
  });
  wrappers.push(mount(probe, { global: { plugins: [router] } }));
  await flushPromises();
  expect(error).not.toHaveBeenCalled();
  return { redirect, router, navigate, fetchBootstrap };
}

describe("login after logout", () => {
  it.each([
    undefined,
    "login_ip_grant",
    "manual_whitelist",
    "local_exempt",
  ] as const)(
    "moves to the login origin while preserving logout for grant %s",
    async (grant) => {
      const { navigate, fetchBootstrap } = await setup({
        auth: { authenticated: !!grant, grant_type: grant, message: "" },
        redirect_to: login,
        redirect_kind: "login",
      });
      expect(fetchBootstrap).toHaveBeenCalledWith(null, true, undefined);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(login);
      const url = new URL(login);
      const canonical = canonicalAuthHistoryTarget(url)!;
      expect(new URL(canonical, url).searchParams.get("logged_out")).toBe("1");
      expect(new URL(canonical, url).searchParams.get("redirect_uri")).toBe(
        target,
      );
    },
  );

  it.each(["authenticated", undefined] as const)(
    "suppresses authenticated and legacy untyped navigation (%s)",
    async (kind) => {
      const { navigate, router } = await setup({
        auth: { authenticated: true, message: "" },
        redirect_to: target,
        redirect_kind: kind,
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(router.currentRoute.value.path).toBe("/login");
    },
  );

  it.each([undefined, "login"] as const)(
    "stays on login without a target (%s)",
    async (kind) => {
      const { navigate, router } = await setup({
        auth: { authenticated: true, message: "" },
        redirect_kind: kind,
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(router.currentRoute.value.path).toBe("/login");
    },
  );

  it.each(["?logged_out=3", ""])(
    "preserves normal navigation for %s",
    async (query) => {
      window.history.replaceState(null, "", `/__auth__/login${query}`);
      const { navigate, fetchBootstrap } = await setup({ redirect_to: target });
      expect(fetchBootstrap).toHaveBeenCalledWith(null, false, undefined);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(target);
    },
  );

  it("guards repeated and self login redirects but allows explicit login completion", async () => {
    const { redirect, navigate, router } = await setup({
      redirect_to: login,
      redirect_kind: "login",
    });
    await redirect.navigateAfterBootstrap({
      authenticated: false,
      redirectTo: login,
      redirectKind: "login",
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(redirect.redirectGuardNotice.value).toBe("auth.redirectLoopBlocked");
    await redirect.navigateAfterBootstrap({
      authenticated: false,
      redirectTo: "/__auth__/login?logged_out=1",
      redirectKind: "login",
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(redirect.redirectGuardNotice.value).toBe(
      "auth.redirectTargetBlocked",
    );
    redirect.completeLogin(0);
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/");
  });

  it("sends logout and return target as separate bootstrap query parameters", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: { data: {} } });
    await AuthAPI.getBootstrap(target, true);
    expect(get).toHaveBeenCalledWith("/bootstrap", {
      params: {
        redirect_uri: target,
        logged_out: "1",
        logout_flow: undefined,
        _ts: expect.any(Number),
      },
    });
    await AuthAPI.getBootstrap(null);
    expect(get).toHaveBeenLastCalledWith("/bootstrap", {
      params: {
        redirect_uri: undefined,
        logged_out: undefined,
        logout_flow: undefined,
        _ts: expect.any(Number),
      },
    });
  });
  it("preserves a valid flow through bootstrap and ignores it without logout", async () => {
    const flow = "ab000000-0000-4000-8000-000000000001";
    window.history.replaceState(
      null,
      "",
      `/__auth__/login?logged_out=1&logout_flow=${flow}`,
    );
    const { fetchBootstrap } = await setup({});
    expect(fetchBootstrap).toHaveBeenCalledWith(null, true, flow);
    window.history.replaceState(
      null,
      "",
      `/__auth__/login?logged_out=3&logout_flow=${flow}`,
    );
    const normal = await setup({});
    expect(normal.fetchBootstrap).toHaveBeenLastCalledWith(
      null,
      false,
      undefined,
    );
    normal.fetchBootstrap.mockRestore();
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: { data: {} } });
    await AuthAPI.getBootstrap(target, true, flow);
    expect(get).toHaveBeenLastCalledWith("/bootstrap", {
      params: {
        redirect_uri: target,
        logged_out: "1",
        logout_flow: flow,
        _ts: expect.any(Number),
      },
    });
    await AuthAPI.getBootstrap(target, false, flow);
    expect(get).toHaveBeenLastCalledWith("/bootstrap", {
      params: {
        redirect_uri: target,
        logged_out: undefined,
        logout_flow: undefined,
        _ts: expect.any(Number),
      },
    });
  });

  it("requests JSON on logout and propagates revocation failures", async () => {
    const data = {
      redirect_to:
        "/login?logged_out=1&logout_flow=ab000000-0000-4000-8000-000000000001",
    };
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue({ data: { data } });
    expect(await AuthAPI.logout()).toEqual(data);
    expect(get).toHaveBeenCalledWith("/logout", {
      headers: { Accept: "application/json" },
    });
    get.mockRejectedValueOnce(new Error("revocation failed"));
    await expect(AuthAPI.logout()).rejects.toThrow("revocation failed");
  });
});
