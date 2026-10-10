import type { Ref } from "vue";
import type { TerminalAttachmentRecord } from "@/lib/api/terminal";
import {
  INPUT_BATCH_MAX_BYTES,
  INPUT_BATCH_WINDOW_MS,
} from "./terminal-runtime";
import {
  encodeInputToBase64,
  getInputByteLength,
  isSafeRemoteTerminalResponse,
  splitTerminalInputByByteLength,
  summarizeTerminalResponseCodePoints,
} from "./terminal-input";

const MAX_PENDING_INPUT_BYTES = 64 * 1024;
type TerminalConnectionState = "idle" | "connecting" | "connected" | "error";
type Owner = Pick<TerminalAttachmentRecord, "id" | "generation">;
type Completion = { error?: unknown };
type InputBatch = { data: string; bytes: number };

const createQueue = () => ({
  owner: null as Owner | null,
  batches: [] as InputBatch[],
  pendingBytes: 0,
  inFlightBytes: 0,
  enqueuedBytes: 0,
  acknowledgedBytes: 0,
  pumping: false,
  timer: null as number | null,
  waiters: [] as {
    through: number;
    complete: (result: Completion) => void;
  }[],
});
type InputQueue = ReturnType<typeof createQueue>;

export const useTerminalInputQueue = ({
  activeAttachment,
  connectionState,
  onSendError,
  onUserInput,
  selectedSessionId,
  sendInput,
  translate,
}: {
  activeAttachment: Readonly<Ref<TerminalAttachmentRecord | null>>;
  connectionState: Readonly<Ref<TerminalConnectionState>>;
  onSendError: (error: unknown) => void;
  onUserInput?: () => void;
  selectedSessionId: Ref<string>;
  sendInput: (attachmentId: string, payload: string) => Promise<unknown>;
  translate: (key: string) => string;
}) => {
  let queue = createQueue();
  // Retain only actual in-flight requests, never one Promise per keystroke.
  // An obsolete request must not block a different attachment, but a reclaimed
  // attachment still waits for its previous request before sending again.
  const inFlight = new Map<string, Promise<unknown>>();
  const noConnection = () =>
    new Error(translate("admin.webTerminal.noConnection"));
  const ownsAttachment = (owner: Owner) =>
    activeAttachment.value?.id === owner.id &&
    activeAttachment.value.generation === owner.generation;
  const cancelTimer = (current: InputQueue) => {
    if (current.timer !== null) window.clearTimeout(current.timer);
    current.timer = null;
  };
  const finishWaiters = (current: InputQueue, result?: Completion) => {
    current.waiters = current.waiters.filter((waiter) => {
      if (result || waiter.through <= current.acknowledgedBytes) {
        waiter.complete(result ?? {});
        return false;
      }
      return true;
    });
  };
  const clearPendingInput = (error: unknown = noConnection()) => {
    const previous = queue;
    queue = createQueue();
    cancelTimer(previous);
    previous.batches = [];
    previous.pendingBytes = 0;
    finishWaiters(previous, { error });
  };
  const isCurrent = (current: InputQueue, owner: Owner) => {
    if (current !== queue) return false;
    if (ownsAttachment(owner)) return true;
    clearPendingInput();
    return false;
  };

  const pump = async (current: InputQueue) => {
    if (current !== queue || current.pumping || !activeAttachment.value) return;
    current.owner ??= {
      id: activeAttachment.value.id,
      generation: activeAttachment.value.generation,
    };
    const owner = current.owner;
    if (!isCurrent(current, owner)) return;
    cancelTimer(current);
    current.pumping = true;
    try {
      const previous = inFlight.get(owner.id);
      if (previous) await previous.catch(() => undefined);
      while (isCurrent(current, owner) && current.batches.length) {
        // Incoming keys merge into the unsent tail while this batch is in flight.
        const batch = current.batches.shift()!;
        current.pendingBytes -= batch.bytes;
        current.inFlightBytes = batch.bytes;
        const request = Promise.resolve().then(() => {
          if (isCurrent(current, owner)) {
            return sendInput(owner.id, encodeInputToBase64(batch.data));
          }
        });
        inFlight.set(owner.id, request);
        try {
          await request;
        } finally {
          if (inFlight.get(owner.id) === request) inFlight.delete(owner.id);
          current.inFlightBytes = 0;
        }
        if (!isCurrent(current, owner)) return;
        current.acknowledgedBytes += batch.bytes;
        finishWaiters(current);
      }
    } catch (error) {
      if (isCurrent(current, owner)) {
        clearPendingInput(error);
        onSendError(error);
      }
    } finally {
      current.pumping = false;
    }
  };

  const waitThroughCurrentInput = (
    current: InputQueue,
  ): Promise<Completion> => {
    if (current.acknowledgedBytes >= current.enqueuedBytes)
      return Promise.resolve({});
    return new Promise((complete) => {
      current.waiters.push({ through: current.enqueuedBytes, complete });
    });
  };

  const flushPendingInput = async () => {
    if (!activeAttachment.value) return;
    const current = queue;
    const completed = waitThroughCurrentInput(current);
    void pump(current);
    // Background flush failures are reported once by the pump. Explicit sends
    // below also propagate the failure to their caller (e.g. the send dialog).
    await completed;
  };

  const enqueue = (data: string, immediate: boolean, userInput: boolean) => {
    if (!data) return;
    if (queue.owner && !ownsAttachment(queue.owner)) clearPendingInput();
    if (!activeAttachment.value && connectionState.value !== "connecting")
      return;
    const current = queue;
    if (activeAttachment.value) {
      current.owner ??= {
        id: activeAttachment.value.id,
        generation: activeAttachment.value.generation,
      };
    }
    // Merge only the unsent tail; already submitted bytes are immutable for retry.
    const tail = current.batches.pop();
    let combined = (tail?.data ?? "") + data;
    if (!activeAttachment.value) {
      const available =
        MAX_PENDING_INPUT_BYTES - current.pendingBytes + (tail?.bytes ?? 0);
      if (available <= 0) {
        if (tail) current.batches.push(tail);
        return;
      }
      combined = splitTerminalInputByByteLength(combined, available)[0] ?? "";
    }
    const chunks = splitTerminalInputByByteLength(
      combined,
      INPUT_BATCH_MAX_BYTES,
    );
    const batches = chunks.map((chunk) => ({
      data: chunk,
      bytes: getInputByteLength(chunk),
    }));
    const addedBytes =
      batches.reduce((sum, batch) => sum + batch.bytes, 0) - (tail?.bytes ?? 0);
    current.batches.push(...batches);
    current.pendingBytes += addedBytes;
    current.enqueuedBytes += addedBytes;
    if (userInput && addedBytes > 0) onUserInput?.();
    if (!activeAttachment.value || current.pumping) return;

    // All C0 controls and DEL bypass the ordinary text window (including
    // backspace/tab). The window starts at the first key and is never extended.
    const hasControl = Array.from(data).some(
      (char) => char.charCodeAt(0) < 32 || char === "\u007f",
    );
    if (
      immediate ||
      hasControl ||
      current.pendingBytes >= INPUT_BATCH_MAX_BYTES
    ) {
      void pump(current);
    } else if (current.timer === null) {
      current.timer = window.setTimeout(() => {
        current.timer = null;
        void pump(current);
      }, INPUT_BATCH_WINDOW_MS);
    }
  };

  const queueTerminalInput = (
    data: string,
    options?: { immediate?: boolean },
  ) => enqueue(data, options?.immediate === true, true);
  const queueRemoteTerminalResponse = (data: string) => {
    if (!isSafeRemoteTerminalResponse(data)) {
      console.warn("[terminal] dropped unexpected terminal response", {
        codePoints: summarizeTerminalResponseCodePoints(data),
        length: data.length,
      });
      return;
    }
    enqueue(data, true, false);
  };
  const sendTerminalPayloadNow = async (payload: string) => {
    if (!payload) return;
    if (!activeAttachment.value) throw noConnection();
    // Enqueue before awaiting anything so a later hardware key cannot overtake
    // a paste, nor can two callers send concurrently with the normal queue.
    enqueue(payload, true, true);
    const result = await waitThroughCurrentInput(queue);
    if ("error" in result) throw result.error;
  };

  return {
    clearPendingInput: () => clearPendingInput(),
    flushPendingInput,
    getPendingInputSnapshot: () => ({
      byteLength: queue.pendingBytes,
      hasPendingInput: queue.pendingBytes > 0,
      inFlightBytes: queue.inFlightBytes,
      sessionId: selectedSessionId.value || null,
    }),
    queueRemoteTerminalResponse,
    queueTerminalInput,
    sendTerminalPayloadNow,
  };
};
