import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HumanFriendlyTime from "@admin-shared/components/common/HumanFriendlyTime.vue";
import { applyDateTimeDisplayMode } from "@admin-shared/composables/useDateTimeDisplayState";
import GatewayLogIpGroups from "../src/views/gateway-request-logs/GatewayLogIpGroups.vue";
import GatewayRequestLogDesktopRow from "../src/views/gateway-request-logs/GatewayRequestLogDesktopRow.vue";
import GatewayRequestLogMobileRow from "../src/views/gateway-request-logs/GatewayRequestLogMobileRow.vue";
import type { GatewayRequestLogRowProps } from "../src/views/gateway-request-logs/gateway-request-log-row-contract";

// This instant falls on the previous calendar day in UTC and Asia/Shanghai.
const timestamp = "2026-09-21T00:30:00+14:00";
const wrappers: VueWrapper[] = [];
const rowProps = (value: string): GatewayRequestLogRowProps => ({
  entry: {
    time: value,
    client_ip: "192.0.2.1",
    actionIp: "192.0.2.1",
    selectionKey: "request-1",
    host: "example.com",
    method: "GET",
    path: "/",
    status: 200,
    duration_ms: 1,
  } as GatewayRequestLogRowProps["entry"],
  blockIpsFromLogs: vi.fn(),
  releaseIpsFromLogs: vi.fn(),
  getConnectionSourceText: () => "",
  getEntryIpLocationText: () => "",
  goToWafTrace: vi.fn(),
  isGeneralBlacklisted: () => false,
  isMutatingBlacklistIps: false,
  isSelected: false,
  toggleSelection: vi.fn(),
  viewDetails: vi.fn(),
});

const render = (view: string, value = timestamp) => {
  const i18n = createI18n({
    legacy: false,
    locale: "en-US",
    missingWarn: false,
    fallbackWarn: false,
  });
  const global = { plugins: [i18n] };
  const wrapper =
    view === "groups"
      ? mount(GatewayLogIpGroups, {
          global,
          props: {
            data: {
              date: "2026-09-21",
              page: 1,
              limit: 20,
              total: 1,
              total_ips: 1,
              total_requests: 1,
              items: [
                {
                  client_ip: "192.0.2.1",
                  requests: 1,
                  hosts: ["example.com"],
                  client_errors: 0,
                  server_errors: 0,
                  waf_hits: 0,
                  first_seen: value,
                  last_seen: value,
                },
              ],
            },
            loading: false,
            sort: "requests",
            location: () => "",
          },
        })
      : mount(
          view === "desktop"
            ? GatewayRequestLogDesktopRow
            : GatewayRequestLogMobileRow,
          {
            global,
            props: rowProps(value),
          },
        );
  wrappers.push(wrapper);
  return { wrapper, i18n };
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-20T12:30:00Z"));
  applyDateTimeDisplayMode("human_friendly");
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  applyDateTimeDisplayMode("human_friendly");
  vi.restoreAllMocks();
});

describe.each(["groups", "desktop", "mobile"])(
  "request log time: %s",
  (view) => {
    it("reacts to display mode and locale using the complete timestamp", async () => {
      const { wrapper, i18n } = render(view);
      const times = wrapper.findAllComponents(HumanFriendlyTime);
      expect(times).toHaveLength(view === "groups" ? 4 : 1);
      for (const time of times) {
        expect(time.props("value")).toBe(timestamp);
        expect(time.text()).toBe("2 hours ago");
        expect(time.element.closest("[title]")).toBeNull();
      }

      applyDateTimeDisplayMode("full");
      await nextTick();
      for (const time of times) {
        expect(time.text()).toBe(new Date(timestamp).toLocaleString("en-US"));
        expect(time.text()).not.toBe("00:30:00");
      }

      i18n.global.locale.value = "zh-CN";
      await nextTick();
      for (const time of times) {
        expect(time.text()).toBe(new Date(timestamp).toLocaleString("zh-CN"));
      }

      applyDateTimeDisplayMode("human_friendly");
      await nextTick();
      for (const time of times) expect(time.text()).toBe("2小时前");
    });

    it.each([
      ["", "-"],
      ["invalid-time", "invalid-time"],
    ])("keeps shared fallback behavior for %j", async (value, expected) => {
      const { wrapper } = render(view, value);
      for (const mode of ["human_friendly", "full"]) {
        applyDateTimeDisplayMode(mode);
        await nextTick();
        for (const time of wrapper.findAllComponents(HumanFriendlyTime)) {
          expect(time.text()).toBe(expected);
          expect(time.find("button").exists()).toBe(false);
        }
      }
    });
  },
);
