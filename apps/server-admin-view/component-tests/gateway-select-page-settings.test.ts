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
const toggle = (wrapper: ReturnType<typeof mount>) => {
  const label = wrapper
    .findAll("label")
    .find((node) => node.text() === enAdmin.gatewaySettings.selectPageTitle)!;
  return wrapper.get(`[id="${label.attributes("for")}"]`);
};

describe("mapping selection page", () => {
  it("does not overwrite a selection-page change from another tab when saving unrelated settings", async () => {
    const wrapper = await setup();
    // Another administrator/tab disabled the page after this form loaded.
    let stored = {
      ...initial,
      portal: { enabled: true, select_page_enabled: false },
    } as GatewaySettings;
    const update = vi
      .spyOn(ConfigAPI, "updateGatewaySettings")
      .mockImplementation(async (patch) => {
        stored = { ...stored, portal: { ...stored.portal, ...patch.portal } };
        return stored;
      });
    await wrapper.findAll('input[type="number"]')[0]!.setValue("2");
    await button(wrapper, enAdmin.gatewaySettings.saveSettings).trigger(
      "click",
    );
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).not.toHaveProperty("portal");
    expect(stored.portal.select_page_enabled).toBe(false);
    expect(toggle(wrapper).attributes("aria-checked")).toBe("false");
  });

  it("defaults legacy settings to enabled and supports reset", async () => {
    const wrapper = await setup();
    expect(toggle(wrapper).attributes("aria-checked")).toBe("true");
    expect(
      button(wrapper, enAdmin.gatewaySettings.saveSettings).attributes(
        "disabled",
      ),
    ).toBeDefined();
    await toggle(wrapper).trigger("click");
    expect(toggle(wrapper).attributes("aria-checked")).toBe("false");
    expect(
      button(wrapper, enAdmin.gatewaySettings.saveSettings).attributes(
        "disabled",
      ),
    ).toBeUndefined();
    await button(wrapper, enAdmin.gatewaySettings.reset).trigger("click");
    expect(toggle(wrapper).attributes("aria-checked")).toBe("true");
  });

  it("saves only the select preference, locks while saving and retains the saved value", async () => {
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
    await toggle(wrapper).trigger("click");
    await button(wrapper, enAdmin.gatewaySettings.saveSettings).trigger(
      "click",
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ portal: { select_page_enabled: false } }),
    );
    expect(toggle(wrapper).attributes("disabled")).toBeDefined();
    const saved = {
      ...initial,
      portal: { enabled: true, select_page_enabled: false },
    } as GatewaySettings;
    resolveSave(saved);
    await flushPromises();
    expect(toggle(wrapper).attributes("aria-checked")).toBe("false");
    expect(
      button(wrapper, enAdmin.gatewaySettings.saveSettings).attributes(
        "disabled",
      ),
    ).toBeDefined();
    await toggle(wrapper).trigger("click");
    await button(wrapper, enAdmin.gatewaySettings.reset).trigger("click");
    expect(toggle(wrapper).attributes("aria-checked")).toBe("false");
    vi.mocked(ConfigAPI.getGatewaySettings).mockResolvedValue(saved);
    const reloaded = await setup();
    expect(toggle(reloaded).attributes("aria-checked")).toBe("false");
  });

  it("keeps an unsaved preference and reports failure when the gateway rejects it", async () => {
    vi.spyOn(ConfigAPI, "updateGatewaySettings").mockRejectedValue(
      new Error("upgrade the gateway backend"),
    );
    const wrapper = await setup();
    await toggle(wrapper).trigger("click");
    await button(wrapper, enAdmin.gatewaySettings.saveSettings).trigger(
      "click",
    );
    await flushPromises();
    expect(mock.error).toHaveBeenCalled();
    expect(toggle(wrapper).attributes("aria-checked")).toBe("false");
    expect(
      button(wrapper, enAdmin.gatewaySettings.saveSettings).attributes(
        "disabled",
      ),
    ).toBeUndefined();
    await button(wrapper, enAdmin.gatewaySettings.reset).trigger("click");
    expect(toggle(wrapper).attributes("aria-checked")).toBe("true");
  });

  it("allows the selection page when the toolbar is disabled", async () => {
    vi.mocked(ConfigAPI.getGatewaySettings).mockResolvedValue({
      ...initial,
      portal: { enabled: false, select_page_enabled: true },
    } as GatewaySettings);
    const wrapper = await setup();
    expect(toggle(wrapper).attributes("aria-checked")).toBe("true");
  });
});
