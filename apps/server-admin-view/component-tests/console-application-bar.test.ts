import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/types";
import { useConfigStore } from "../src/store/config";
import ConsoleApplicationBar from "../src/views/layout/ConsoleApplicationBar.vue";

const accessEntry = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/api/system", () => ({
  SystemAPI: { getAccessEntry: accessEntry.load },
}));

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      common: {
        loading: "Loading...",
        loadConfigFailed: "Failed to load configuration",
        refreshStatus: "Refresh",
      },
      admin: {
        consoleApplicationList: {
          label: "Apps",
          ariaLabel: "Console application list",
          empty: "No applications available",
          openApplication: "Open {name} in a new tab",
        },
      },
    },
  },
});

const pathConfig = (): AppConfig =>
  ({
    runtime_profile: { deployment_target: "fpk" },
    dashboard_display: { show_console_app_list: true },
    run_type: 1,
    reverse_proxy_submode: "path",
    host_mappings: [],
    host_mapping_groups: [],
    host_mapping_grouped_view: false,
    proxy_mappings: [
      {
        path: "/photos",
        target: "http://photos:3000",
        rewrite_html: false,
        use_auth: true,
        use_root_mode: false,
        strip_path: false,
      },
    ],
  }) as AppConfig;

const hostConfig = (faviconOverride: string, showAppIcon = true): AppConfig =>
  ({
    ...pathConfig(),
    run_type: 3,
    gateway_portal: {
      enabled: true,
      display_style: "title",
      show_app_icon: showAppIcon,
      show_wol: true,
      icon_drag_mode: "corners",
      version: "v1",
    },
    host_mappings: [
      {
        host: "photos.example.test",
        service_role: "app",
        disabled: false,
        group_id: null,
        title: "Photos",
        title_override: "",
        favicon: "",
        favicon_override: faviconOverride,
      },
    ],
    proxy_mappings: [],
  }) as AppConfig;

describe("ConsoleApplicationBar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    accessEntry.load.mockResolvedValue({ port: "7999" });
    setActivePinia(createPinia());
    document.body.replaceChildren();
    window.location.href = "http://172.28.0.10:5666/";
  });

  const openDialog = async (wrapper: ReturnType<typeof mount>) => {
    await wrapper.get("button").trigger("click");
    await flushPromises();
    const content = document.body.querySelector<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    expect(content).not.toBeNull();
    return new DOMWrapper(content!);
  };

  it("opens an application dialog with a responsive new-tab application grid", async () => {
    const store = useConfigStore();
    store.config = pathConfig();
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });

    await flushPromises();
    const nav = wrapper.get("nav");
    expect(nav.attributes("aria-label")).toBe("Console application list");
    expect(nav.classes()).toContain("max-w-full");
    expect(nav.classes()).toContain("overflow-hidden");
    expect(nav.classes()).toContain("shadow-none");
    expect(wrapper.get("ul").classes()).toContain("overflow-x-auto");
    expect(wrapper.get("ul").classes()).toContain("cursor-grab");
    expect(wrapper.get("ul").classes()).toContain("snap-x");
    const barLink = wrapper.get("ul a");
    expect(barLink.attributes("href")).toMatch(/:7999\/photos\/$/u);

    const trigger = wrapper.get("button");
    expect(trigger.attributes("aria-label")).toBe("Console application list");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    const dialog = await openDialog(wrapper);
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(dialog.text()).toContain("Apps");

    const grid = dialog.get('[data-testid="console-application-grid"]');
    expect(grid.classes()).toContain(
      "grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))]",
    );
    const link = grid.get("a");
    expect(link.attributes("target")).toBe("_blank");
    expect(link.attributes("rel")).toBe("noopener noreferrer");
    expect(link.attributes("aria-label")).toBe("Open /photos in a new tab");
    expect(link.attributes("href")).toMatch(/:7999\/photos\/$/u);
    expect(link.attributes("title")).toBe("/photos");
    expect(link.attributes("title")).not.toContain("photos:3000");
    expect(accessEntry.load).toHaveBeenCalledTimes(1);

    const focusSpy = vi.spyOn(trigger.element, "focus");
    await dialog.get('[data-slot="dialog-close"]').trigger("click");
    await nextTick();
    expect(
      document.body.querySelector('[data-slot="dialog-content"]'),
    ).toBeNull();
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("shows the empty state inside the dialog when no application is configured", async () => {
    const store = useConfigStore();
    store.config = { ...pathConfig(), proxy_mappings: [] };
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });

    await flushPromises();
    expect(wrapper.text()).toContain("No applications available");
    const dialog = await openDialog(wrapper);
    expect(dialog.text()).toContain("No applications available");
    expect(dialog.find("a").exists()).toBe(false);
  });

  it("does not render or load the gateway entry outside FPK", () => {
    const store = useConfigStore();
    store.config = {
      ...pathConfig(),
      runtime_profile: {
        deployment_target: "docker",
      },
    } as AppConfig;
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });

    expect(wrapper.find("button").exists()).toBe(false);
    expect(accessEntry.load).not.toHaveBeenCalled();
  });

  it("waits for FRP entry resolution before linking from the HTTP fnOS console", async () => {
    let resolveEntry!: (value: { port: string }) => void;
    accessEntry.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEntry = resolve;
        }),
    );
    const store = useConfigStore();
    store.config = {
      ...hostConfig("", false),
      run_type: 1,
      reverse_proxy_submode: "subdomain",
      default_tunnel: "frp",
      ssl: { enabled: true },
      subdomain_mode: { public_http_port: 7999, public_https_port: 0 },
    } as AppConfig;
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });
    expect(wrapper.find("a").exists()).toBe(false);
    expect(wrapper.text()).toContain("Loading...");
    const dialog = await openDialog(wrapper);
    expect(dialog.find("a").exists()).toBe(false);

    resolveEntry({ port: "27999" });
    await flushPromises();
    expect(wrapper.get("ul a").attributes("href")).toBe(
      "https://photos.example.test:27999/",
    );
    expect(dialog.get("a").attributes("href")).toBe(
      "https://photos.example.test:27999/",
    );
    wrapper.unmount();
  });

  it("does not expose a fallback link on failure and retries when the dialog opens", async () => {
    accessEntry.load.mockRejectedValueOnce(new Error("offline"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    useConfigStore().config = pathConfig();
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });
    await flushPromises();
    expect(wrapper.find("a").exists()).toBe(false);
    expect(wrapper.text()).toContain("Failed to load configuration");

    accessEntry.load.mockResolvedValueOnce({ port: "27999" });
    const dialog = await openDialog(wrapper);
    expect(dialog.get("a").attributes("href")).toBe(
      "http://172.28.0.10:27999/photos/",
    );
    expect(accessEntry.load).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    warning.mockRestore();
  });

  it("allows retry after invalid entry responses inside the open dialog", async () => {
    accessEntry.load.mockResolvedValue({ port: "invalid" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    useConfigStore().config = pathConfig();
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });
    const dialog = await openDialog(wrapper);
    expect(dialog.find("a").exists()).toBe(false);
    const retry = dialog
      .findAll("button")
      .find((button) => button.text() === "Refresh")!;
    expect(retry).toBeDefined();
    accessEntry.load.mockResolvedValue({ port: "27999" });
    await retry.trigger("click");
    await flushPromises();
    expect(dialog.get("a").attributes("href")).toBe(
      "http://172.28.0.10:27999/photos/",
    );
    wrapper.unmount();
    warning.mockRestore();
  });

  it("reloads on tunnel changes and ignores responses from an older mode", async () => {
    let resolveOldEntry!: (value: { port: string }) => void;
    accessEntry.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldEntry = resolve;
        }),
    );
    const store = useConfigStore();
    store.config = { ...pathConfig(), default_tunnel: "cloudflared" };
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });
    accessEntry.load.mockResolvedValueOnce({ port: "27999" });
    store.config.default_tunnel = "frp";
    await flushPromises();
    expect(wrapper.get("a").attributes("href")).toBe(
      "http://172.28.0.10:27999/photos/",
    );
    resolveOldEntry({ port: "7999" });
    await flushPromises();
    expect(wrapper.get("a").attributes("href")).toBe(
      "http://172.28.0.10:27999/photos/",
    );
    expect(accessEntry.load).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("retries a Host icon after its source changes", async () => {
    const firstIcon = "data:image/png;base64,Zmlyc3Q=";
    const nextIcon = "data:image/png;base64,c2Vjb25k";
    const store = useConfigStore();
    store.config = hostConfig(firstIcon);
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });
    const dialog = await openDialog(wrapper);

    await dialog.get("img").trigger("error");
    expect(dialog.find("img").exists()).toBe(false);

    store.config = hostConfig(nextIcon);
    await nextTick();
    expect(dialog.get("img").attributes("src")).toBe(nextIcon);
  });

  it("hides the Host icon completely when portal icons are disabled", async () => {
    const store = useConfigStore();
    store.config = hostConfig("", false);
    const wrapper = mount(ConsoleApplicationBar, {
      global: { plugins: [i18n] },
    });
    const dialog = await openDialog(wrapper);

    const link = dialog.get("a");
    expect(link.find("img").exists()).toBe(false);
    expect(link.find("svg").exists()).toBe(false);
  });
});
