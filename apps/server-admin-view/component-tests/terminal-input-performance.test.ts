import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalAttachmentRecord } from "@/lib/api/terminal";
import { useTerminalInputQueue } from "@/views/web-terminal/useTerminalInputQueue";
import { encodeTerminalInputToBytes } from "@/views/web-terminal/terminal-input";

const attachment = (id = "a", generation = 1): TerminalAttachmentRecord => ({
  id,
  generation,
  sessionId: "s",
  role: "controller",
  cursor: 0,
  expiresAt: "2099-01-01T00:00:00Z",
  transport: "http-polling",
});
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const setup = (
  sendInput = vi
    .fn<(id: string, payload: string) => Promise<unknown>>()
    .mockResolvedValue(undefined),
) => {
  const activeAttachment = ref<TerminalAttachmentRecord | null>(attachment());
  const connectionState = ref<"connected" | "connecting">("connected");
  const onSendError = vi.fn();
  const onUserInput = vi.fn();
  return {
    activeAttachment,
    connectionState,
    onSendError,
    onUserInput,
    sendInput,
    queue: useTerminalInputQueue({
      activeAttachment,
      connectionState,
      onSendError,
      onUserInput,
      selectedSessionId: ref("s"),
      sendInput,
      translate: (key) => key,
    }),
  };
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const sentText = (send: ReturnType<typeof setup>["sendInput"]) =>
  send.mock.calls.map(([, value]) => atob(value)).join("");
afterEach(() => vi.useRealTimers());

describe("terminal input under latency", () => {
  for (const rtt of [20, 80, 150])
    for (const duration of [2000, 10000])
      for (const key of ["\x1b[C", "x"]) {
        it(`${JSON.stringify(key)} at 30Hz for ${duration}ms with ${rtt}ms requests stays ordered and drains within two requests`, async () => {
          vi.useFakeTimers();
          vi.setSystemTime(0);
          let active = 0,
            maxActive = 0,
            completedAt = 0;
          const send = vi.fn<(id: string, payload: string) => Promise<unknown>>(
            () =>
              new Promise<void>((resolve) => {
                maxActive = Math.max(maxActive, ++active);
                window.setTimeout(() => {
                  active--;
                  completedAt = Date.now();
                  resolve();
                }, rtt);
              }),
          );
          const { queue } = setup(send);
          const count = (duration / 1000) * 30;
          for (let i = 0; i < count; i++)
            window.setTimeout(
              () => queue.queueTerminalInput(key),
              Math.floor((i * 1000) / 30),
            );
          const lastKey = Math.floor(((count - 1) * 1000) / 30);
          await vi.advanceTimersByTimeAsync(lastKey);
          const drained = queue.flushPendingInput();
          await vi.runAllTimersAsync();
          await drained;
          expect(sentText(send)).toBe(key.repeat(count));
          expect(maxActive).toBe(1);
          expect(completedAt - lastKey).toBeLessThanOrEqual(rtt * 2 + 10);
          expect(send.mock.calls.length).toBeLessThanOrEqual(
            Math.ceil(duration / rtt) + 1,
          );
          expect(queue.getPendingInputSnapshot()).toMatchObject({
            byteLength: 0,
            inFlightBytes: 0,
          });
        });
      }

  it("uses the first text key's deadline and bypasses it for backspace/tab/control keys", async () => {
    vi.useFakeTimers();
    const { queue, sendInput } = setup();
    queue.queueTerminalInput("a");
    await vi.advanceTimersByTimeAsync(9);
    queue.queueTerminalInput("b");
    await vi.advanceTimersByTimeAsync(1);
    expect(sentText(sendInput)).toBe("ab");
    for (const key of ["\x7f", "\t", "\x03", "\x1b[D", "\r"]) {
      queue.queueTerminalInput(key);
      await settle();
      expect(atob(sendInput.mock.calls.at(-1)![1])).toBe(key);
    }
  });

  it("serializes explicit paste, typed keys and another explicit send without losing UTF-8 or mouse bytes", async () => {
    const first = deferred();
    const send = vi
      .fn<(id: string, payload: string) => Promise<unknown>>()
      .mockResolvedValue(undefined)
      .mockReturnValueOnce(first.promise);
    const { queue } = setup(send);
    const paste =
      "界😀".repeat(1000) + "\x1b[M" + String.fromCharCode(32, 200, 201);
    const sent = queue.sendTerminalPayloadNow(paste);
    queue.queueTerminalInput("typed");
    const second = queue.sendTerminalPayloadNow("\r");
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([sent, second]);
    const bytes = Uint8Array.from(sentText(send), (char) => char.charCodeAt(0));
    expect(bytes).toEqual(encodeTerminalInputToBytes(paste + "typed\r"));
    expect(
      send.mock.calls.every(([, encoded]) => atob(encoded).length <= 1024),
    ).toBe(true);
  });

  it("completes an explicit send at its own acknowledgement even if later keys remain in flight", async () => {
    const first = deferred(),
      second = deferred();
    const { queue } = setup(
      vi
        .fn<(id: string, payload: string) => Promise<unknown>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    );
    const sent = queue.sendTerminalPayloadNow("first");
    queue.queueTerminalInput("later", { immediate: true });
    first.resolve();
    await sent;
    expect(queue.getPendingInputSnapshot().inFlightBytes).toBe(5);
    second.resolve();
    await queue.flushPendingInput();
  });

  it("reports a failed batch once, rejects explicit sends and discards all following bytes", async () => {
    const first = deferred();
    const { queue, sendInput, onSendError } = setup(
      vi
        .fn<(id: string, payload: string) => Promise<unknown>>()
        .mockReturnValue(first.promise),
    );
    const error = new Error("failed");
    const result = expect(queue.sendTerminalPayloadNow("first")).rejects.toBe(
      error,
    );
    queue.queueTerminalInput("must not send", { immediate: true });
    const background = queue.flushPendingInput();
    first.reject(error);
    await result;
    await background;
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(onSendError).toHaveBeenCalledExactlyOnceWith(error);
    expect(queue.getPendingInputSnapshot().byteLength).toBe(0);
  });

  it("does not let a stale failed request block or clear a different attachment", async () => {
    const old = deferred(),
      next = deferred();
    const state = setup(
      vi
        .fn<(id: string, payload: string) => Promise<unknown>>()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise),
    );
    const cancelled = expect(
      state.queue.sendTerminalPayloadNow("old"),
    ).rejects.toThrow();
    await settle();
    state.queue.queueTerminalInput("discard", { immediate: true });
    state.queue.clearPendingInput();
    state.activeAttachment.value = attachment("b");
    const sent = state.queue.sendTerminalPayloadNow("new");
    await settle();
    expect(state.sendInput.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    old.reject(new Error("obsolete"));
    await cancelled;
    await settle();
    expect(state.onSendError).not.toHaveBeenCalled();
    expect(state.queue.getPendingInputSnapshot().inFlightBytes).toBe(3);
    next.resolve();
    await sent;
  });

  it("waits for an obsolete request to settle before reusing the same attachment with a new generation", async () => {
    const old = deferred();
    const state = setup(
      vi
        .fn<(id: string, payload: string) => Promise<unknown>>()
        .mockResolvedValue(undefined)
        .mockReturnValueOnce(old.promise),
    );
    state.queue.queueTerminalInput("old", { immediate: true });
    await settle();
    state.queue.queueTerminalInput("discard", { immediate: true });
    state.queue.clearPendingInput();
    state.activeAttachment.value = attachment("a", 2);
    const sent = state.queue.sendTerminalPayloadNow("new");
    await settle();
    expect(state.sendInput).toHaveBeenCalledTimes(1);
    old.resolve();
    await sent;
    expect(sentText(state.sendInput)).toBe("oldnew");
  });

  it("invalidates a delayed text batch when attachment generation changes", async () => {
    vi.useFakeTimers();
    const state = setup();
    state.queue.queueTerminalInput("old");
    state.activeAttachment.value = attachment("a", 2);
    await vi.runAllTimersAsync();
    expect(state.sendInput).not.toHaveBeenCalled();
    await state.queue.sendTerminalPayloadNow("new");
    expect(sentText(state.sendInput)).toBe("new");
  });

  it("bounds early input and excludes protocol responses from user activity", async () => {
    const state = setup();
    state.activeAttachment.value = null;
    state.connectionState.value = "connecting";
    state.queue.queueTerminalInput("a".repeat(70 * 1024));
    expect(state.queue.getPendingInputSnapshot().byteLength).toBe(64 * 1024);
    state.activeAttachment.value = attachment();
    await state.queue.flushPendingInput();
    expect(sentText(state.sendInput)).toBe("a".repeat(64 * 1024));
    state.onUserInput.mockClear();
    state.queue.queueRemoteTerminalResponse("\x1b[0n");
    await state.queue.flushPendingInput();
    expect(state.onUserInput).not.toHaveBeenCalled();
    await state.queue.sendTerminalPayloadNow("paste");
    expect(state.onUserInput).toHaveBeenCalledOnce();
  });
});
