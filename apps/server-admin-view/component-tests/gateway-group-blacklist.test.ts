import { flushPromises, mount } from "@vue/test-utils";
import { computed, defineComponent, h, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  add: vi.fn(),
  delete: vi.fn(),
  status: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../src/lib/api/security", () => ({
  GeneralBlacklistAPI: {
    add: api.add,
    delete: api.delete,
    getStatus: api.status,
  },
}));
vi.mock("@admin-shared/utils/toast", () => ({
  toast: { success: api.success, error: api.error },
}));
import { useGatewayLogIpSelection } from "../src/views/gateway-request-logs/useGatewayLogIpSelection";
const setup = () => {
  const groups = ref(["1.1.1.1", "8.8.8.8", "", "1.1.1.1"]);
  const selected = ref(new Set<string>());
  let selection!: ReturnType<typeof useGatewayLogIpSelection>;
  const wrapper = mount(
    defineComponent({
      setup() {
        selection = useGatewayLogIpSelection({
          displayedEntries: computed(() =>
            groups.value.map((ip) => ({ actionIp: ip, selectionKey: ip })),
          ),
          selectedLogEntryKeys: selected,
          translate: (key) => key,
        });
        return () => h("div");
      },
    }),
  );
  return { selection, selected, groups, wrapper };
};
beforeEach(() => {
  vi.clearAllMocks();
  api.status.mockResolvedValue({ records: { "8.8.8.8": { ip: "8.8.8.8" } } });
  api.add.mockResolvedValue({ added: 1, updated: 0 });
  api.delete.mockResolvedValue({ removed: 1 });
});
describe("IP group blacklist actions", () => {
  it("selects valid IPs, deduplicates and separates mixed blacklist states", async () => {
    const { selection, selected, wrapper } = setup();
    await flushPromises();
    selection.isAllDisplayedRowsSelected.value = true;
    expect([...selected.value]).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(selection.selectedBlockedLogIps.value).toEqual(["8.8.8.8"]);
    expect(selection.selectedUnblockedLogIps.value).toEqual(["1.1.1.1"]);
    api.status.mockResolvedValueOnce({
      records: { "1.1.1.1": { ip: "1.1.1.1" }, "8.8.8.8": { ip: "8.8.8.8" } },
    });
    await selection.blockIpsFromLogs(["1.1.1.1", "1.1.1.1", "", "8.8.8.8"]);
    expect(api.add).toHaveBeenCalledExactlyOnceWith(["1.1.1.1"], "request_log");
    expect(selection.isGeneralBlacklisted("1.1.1.1")).toBe(true);
    expect([...selected.value]).toEqual(["8.8.8.8"]);
    api.status.mockResolvedValueOnce({ records: {} });
    await selection.releaseIpsFromLogs(["8.8.8.8", "8.8.8.8"]);
    expect(api.delete).toHaveBeenCalledExactlyOnceWith(["8.8.8.8"]);
    expect(selection.isGeneralBlacklisted("8.8.8.8")).toBe(false);
    wrapper.unmount();
  });
  it("prevents repeat submission and retains selection on failure", async () => {
    const { selection, selected, wrapper } = setup();
    await flushPromises();
    selected.value = new Set(["1.1.1.1"]);
    let reject!: (error: Error) => void;
    api.add.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const first = selection.blockIpsFromLogs(["1.1.1.1"]);
    expect(selection.isMutatingBlacklistIps.value).toBe(true);
    await selection.blockIpsFromLogs(["1.1.1.1"]);
    expect(api.add).toHaveBeenCalledTimes(1);
    await selection.releaseIpsFromLogs(["8.8.8.8"]);
    expect(api.delete).not.toHaveBeenCalled();
    reject(new Error("unavailable"));
    await first;
    expect(api.error).toHaveBeenCalled();
    expect([...selected.value]).toEqual(["1.1.1.1"]);
    expect(selection.isMutatingBlacklistIps.value).toBe(false);
    wrapper.unmount();
  });
});
