import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigAPI } from "../src/lib/api/config";
import type { GatewaySettings } from "../src/types";
import GatewaySettingsView from "../src/views/system-settings/GatewaySettings.vue";
import { enAdmin } from "../../../packages/i18n/src/messages/admin/en";

const mock = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("../src/store/config", () => ({
  useConfigStore: () => ({
    loadConfig: mock.loadConfig,
    config: { run_type: 3 },
  }),
}));
vi.mock("@admin-shared/utils/toast", () => ({
  toast: { error: mock.error, success: mock.success },
}));
// Deliberately simulate a legacy response without the new field.
const initial = {
  auth_cache_ttl_seconds: 1,
  auth_cache_unauthorized_ttl_seconds: 1,
  reverse_proxy_throttle: {
    enabled: true,
    requests_per_second: 500,
    burst: 1000,
    block_seconds: 30,
  },
  unmatched_route: { behavior: "error_page", upstream_error_detail: "less" },
} as GatewaySettings;
const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(ConfigAPI, "getGatewaySettings").mockResolvedValue(
    structuredClone(initial),
  );
  mock.loadConfig.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
});
const setup = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/system", component: GatewaySettingsView }],
  });
  await router.push("/system");
  const wrapper = mount(GatewaySettingsView, {
    global: {
      plugins: [
        router,
        createI18n({
          legacy: false,
          locale: "en",
          messages: { en: { admin: enAdmin } },
        }),
      ],
      stubs: {
        FloatingActionDock: { template: '<div><slot name="inline" /></div>' },
      },
    },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
};
const button = (wrapper: ReturnType<typeof mount>, label: string) =>
  wrapper.findAll("button").find((b) => b.text() === label)!;
const choices = (wrapper: ReturnType<typeof mount>) =>
  wrapper
    .get('[role="group"][aria-label="Disabled domain behavior"]')
    .findAll("button");

describe("disabled domain behavior", () => {
  it("defaults legacy responses to page and supports dirty tracking and reset", async () => {
    const wrapper = await setup();
    const save = button(wrapper, enAdmin.gatewaySettings.saveSettings);
    expect(choices(wrapper)[0].attributes("aria-pressed")).toBe("true");
    expect(save.attributes("disabled")).toBeDefined();
    await choices(wrapper)[1].trigger("click");
    expect(save.attributes("disabled")).toBeUndefined();
    await button(wrapper, enAdmin.gatewaySettings.reset).trigger("click");
    expect(choices(wrapper)[0].attributes("aria-pressed")).toBe("true");
    expect(save.attributes("disabled")).toBeDefined();
  });

  it("saves independently, disables during save, and uses the saved value on reset", async () => {
    let resolveSave!: (value: GatewaySettings) => void;
    const update = vi
      .spyOn(ConfigAPI, "updateGatewaySettings")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      );
    const wrapper = await setup();
    await choices(wrapper)[1].trigger("click");
    await button(wrapper, enAdmin.gatewaySettings.saveSettings).trigger(
      "click",
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        unmatched_route: {
          behavior: "error_page",
          upstream_error_detail: "less",
          disabled_host_behavior: "reset_connection",
        },
      }),
    );
    expect(
      choices(wrapper).every((b) => b.attributes("disabled") !== undefined),
    ).toBe(true);
    resolveSave({
      ...initial,
      unmatched_route: {
        ...initial.unmatched_route,
        disabled_host_behavior: "reset_connection",
      },
    });
    await flushPromises();
    expect(
      button(wrapper, enAdmin.gatewaySettings.saveSettings).attributes(
        "disabled",
      ),
    ).toBeDefined();
    expect(choices(wrapper)[1].attributes("aria-pressed")).toBe("true");
    await choices(wrapper)[0].trigger("click");
    await button(wrapper, enAdmin.gatewaySettings.reset).trigger("click");
    expect(choices(wrapper)[1].attributes("aria-pressed")).toBe("true");
  });

  it("retains unsaved selection when the gateway rejects the setting", async () => {
    vi.spyOn(ConfigAPI, "updateGatewaySettings").mockRejectedValue(
      new Error("upgrade the gateway backend"),
    );
    const wrapper = await setup();
    await choices(wrapper)[1].trigger("click");
    await button(wrapper, enAdmin.gatewaySettings.saveSettings).trigger(
      "click",
    );
    await flushPromises();
    expect(mock.error).toHaveBeenCalled();
    expect(choices(wrapper)[1].attributes("aria-pressed")).toBe("true");
    expect(
      button(wrapper, enAdmin.gatewaySettings.saveSettings).attributes(
        "disabled",
      ),
    ).toBeUndefined();
  });
});
