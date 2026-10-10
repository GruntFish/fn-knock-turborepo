import type { Terminal } from "ghostty-web";

export const CURSOR_ACTIVITY_IDLE_MS = 530;

/** Keep the cursor visible during input, without overriding DEC cursor visibility. */
export function createTerminalCursorActivity(
  getTerminal: () => Pick<Terminal, "options" | "wasmTerm"> | null,
) {
  let timer: number | null = null;
  let disposed = false;
  let lastCursor: { x: number; y: number } | null = null;
  const cancelTimer = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const markActivity = () => {
    if (disposed) return;
    const terminal = getTerminal();
    if (!terminal) return;
    cancelTimer();
    // The public option setter stops the blink timer and restores its visible
    // phase. The renderer still respects the application's ?25l / ?25h modes.
    terminal.options.cursorBlink = false;
    timer = window.setTimeout(() => {
      timer = null;
      if (!disposed && getTerminal() === terminal)
        terminal.options.cursorBlink = true;
    }, CURSOR_ACTIVITY_IDLE_MS);
  };
  const observeOutput = () => {
    if (disposed) return;
    const cursor = getTerminal()?.wasmTerm?.getCursor();
    if (!cursor) return;
    if (
      lastCursor &&
      (cursor.x !== lastCursor.x || cursor.y !== lastCursor.y)
    ) {
      markActivity();
    }
    lastCursor = { x: cursor.x, y: cursor.y };
  };
  const reset = () => {
    if (disposed) return;
    cancelTimer();
    const terminal = getTerminal();
    if (terminal) terminal.options.cursorBlink = true;
    const cursor = terminal?.wasmTerm?.getCursor();
    lastCursor = cursor ? { x: cursor.x, y: cursor.y } : null;
  };
  return {
    markActivity,
    observeOutput,
    reset,
    dispose: () => {
      reset();
      disposed = true;
    },
  };
}
