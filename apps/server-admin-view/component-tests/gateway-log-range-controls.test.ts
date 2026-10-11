import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import GatewayLogRangeControls from "../src/views/gateway-request-logs/GatewayLogRangeControls.vue";
const setup = () =>
  mount(GatewayLogRangeControls, {
    props: { from: "2026-09-21", to: "2026-09-21", today: "2026-09-21" },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: "en",
          missingWarn: false,
          fallbackWarn: false,
        }),
      ],
    },
  });
describe("gateway date range controls", () => {
  it("validates both dates before applying and includes both ends of the 30-day range", async () => {
    const wrapper = setup();
    const [from, to] = wrapper.findAll('input[type="date"]');
    await from!.setValue("2026-08-22");
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    await from!.setValue("2026-08-23");
    await wrapper.find("button").trigger("click");
    expect(wrapper.emitted("change")?.[0]).toEqual([
      "2026-08-23",
      "2026-09-21",
    ]);
    await to!.setValue("2026-09-22");
    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
  it("bases shortcuts on the server's today and updates drafts after navigation", async () => {
    const wrapper = setup();
    await wrapper.findAll("button")[2]!.trigger("click");
    expect(wrapper.emitted("change")?.[0]).toEqual([
      "2026-09-15",
      "2026-09-21",
    ]);
    await wrapper.findAll("button")[3]!.trigger("click");
    expect(wrapper.emitted("change")?.[1]).toEqual([
      "2026-08-23",
      "2026-09-21",
    ]);
    await wrapper.setProps({ from: "2026-09-19", to: "2026-09-20" });
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("2026-09-19");
    wrapper.unmount();
  });
});
