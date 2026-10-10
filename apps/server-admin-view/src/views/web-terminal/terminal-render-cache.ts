import type { Terminal, GhosttyCell } from "ghostty-web";

/**
 * ghostty-web 0.4.0's getLine() reads the entire viewport for every row.
 * Scope the shared cell pool to ONE synchronous render, never to a frame ID:
 * resize/selection can render again before the next animation frame.
 */
export function bindTerminalRenderCache(
  term: Pick<Terminal, "renderer" | "wasmTerm">,
) {
  const renderer = term.renderer;
  const wasm = term.wasmTerm;
  if (!renderer || !wasm) return () => {};
  const originalRender = renderer.render;
  const originalGetViewport = wasm.getViewport;
  const originalIsRowDirty = wasm.isRowDirty;
  let scope: {
    viewport: GhosttyCell[] | null;
    cursorRow: number | null;
  } | null = null;
  let lastCursor = wasm.getCursor();

  const getViewport: typeof wasm.getViewport = function () {
    if (!scope) return originalGetViewport.call(wasm);
    return (scope.viewport ??= originalGetViewport.call(wasm));
  };
  const isRowDirty: typeof wasm.isRowDirty = function (row) {
    return scope?.cursorRow === row || originalIsRowDirty.call(wasm, row);
  };
  const render: typeof renderer.render = function (...args) {
    const previous = scope;
    // Historical scrollback uses a separate path and retains native behavior.
    scope =
      args[0] === wasm && (args[2] ?? 0) === 0
        ? { viewport: null, cursorRow: null }
        : null;
    try {
      const cursor = wasm.getCursor();
      // With blinking disabled, 0.4.0 does not dirty a stationary cursor's
      // row on ?25l. Dirty just its old row to erase the existing pixels.
      // Keep this in the normal render loop; do not paint synchronously on echo.
      if (scope && lastCursor.visible && !cursor.visible)
        scope.cursorRow = lastCursor.y;
      const result = originalRender.apply(renderer, args);
      lastCursor = cursor;
      return result;
    } finally {
      scope = previous;
    }
  };
  wasm.getViewport = getViewport;
  wasm.isRowDirty = isRowDirty;
  renderer.render = render;
  return () => {
    if (renderer.render === render) renderer.render = originalRender;
    if (wasm.getViewport === getViewport)
      wasm.getViewport = originalGetViewport;
    if (wasm.isRowDirty === isRowDirty) wasm.isRowDirty = originalIsRowDirty;
    scope = null;
  };
}
