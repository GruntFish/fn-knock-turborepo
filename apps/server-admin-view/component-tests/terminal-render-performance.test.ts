import { afterEach, describe, expect, it, vi } from "vitest";
import type { GhosttyCell, Terminal } from "ghostty-web";
import { bindTerminalRenderCache } from "@/views/web-terminal/terminal-render-cache";
import { createTerminalCursorActivity } from "@/views/web-terminal/terminal-cursor-activity";

afterEach(() => vi.useRealTimers());

const renderFixture = () => {
  let version = 0;
  const getViewport = vi.fn(() => [{ codepoint: ++version }] as GhosttyCell[]);
  const cursor = { visible: true, y: 0 };
  const isRowDirty = vi.fn(() => false);
  const wasm = { getViewport, getCursor: () => ({ ...cursor }), isRowDirty };
  const render = vi.fn(() => [
    wasm.getViewport(),
    wasm.getViewport(),
    wasm.getViewport(),
  ]);
  const renderer = { render };
  const term = { renderer, wasmTerm: wasm } as unknown as Pick<
    Terminal,
    "renderer" | "wasmTerm"
  >;
  return {
    term,
    wasm,
    renderer,
    getViewport,
    cursor,
    isRowDirty,
    render,
    draw: (scroll = 0) => term.renderer!.render(term.wasmTerm!, false, scroll),
  };
};

describe("Ghostty render cache", () => {
  it("dirties only the old cursor row once when the application hides it", () => {
    const f = renderFixture();
    const dirtyRows: boolean[][] = [];
    f.render.mockImplementation(() => {
      dirtyRows.push([
        f.term.wasmTerm!.isRowDirty(0),
        f.term.wasmTerm!.isRowDirty(1),
      ]);
      return [f.wasm.getViewport()];
    });
    const dispose = bindTerminalRenderCache(f.term);
    f.draw();
    f.cursor.visible = false;
    f.draw();
    f.draw();
    expect(dirtyRows).toEqual([
      [false, false],
      [true, false],
      [false, false],
    ]);
    expect(f.render).toHaveBeenLastCalledWith(f.wasm, false, 0);
    expect(f.getViewport).toHaveBeenCalledTimes(3);
    dispose();
    expect(f.wasm.isRowDirty).toBe(f.isRowDirty);
  });
  it("shares viewport reads only inside each live render and refreshes after writes/resizes", () => {
    const f = renderFixture();
    const dispose = bindTerminalRenderCache(f.term);
    f.draw();
    expect(f.getViewport).toHaveBeenCalledTimes(1);
    const first = f.render.mock.results[0]!.value;
    expect(first[0]).toBe(first[1]);
    f.draw();
    expect(f.getViewport).toHaveBeenCalledTimes(2);
    expect(f.render.mock.results[1]!.value[0]).not.toBe(first[0]);
    f.wasm.getViewport();
    f.wasm.getViewport();
    expect(f.getViewport).toHaveBeenCalledTimes(4);
    dispose();
    expect(f.wasm.getViewport).toBe(f.getViewport);
    expect(f.renderer.render).toBe(f.render);
    f.draw();
    expect(f.getViewport).toHaveBeenCalledTimes(7);
  });

  it("retains native scrollback behavior and does not share state between terminals", () => {
    const a = renderFixture(),
      b = renderFixture();
    const stopA = bindTerminalRenderCache(a.term),
      stopB = bindTerminalRenderCache(b.term);
    a.draw(3);
    expect(a.getViewport).toHaveBeenCalledTimes(3);
    b.draw();
    expect(b.getViewport).toHaveBeenCalledTimes(1);
    a.draw();
    expect(a.getViewport).toHaveBeenCalledTimes(4);
    stopA();
    stopB();
  });

  it("clears the cache even when rendering throws and forwards renderer arguments", () => {
    const f = renderFixture();
    f.render.mockImplementationOnce(() => {
      f.wasm.getViewport();
      throw new Error("paint failed");
    });
    const dispose = bindTerminalRenderCache(f.term);
    expect(() => f.draw()).toThrow("paint failed");
    f.wasm.getViewport();
    expect(f.getViewport).toHaveBeenCalledTimes(2);
    f.term.renderer!.render(f.term.wasmTerm!, true, 0, undefined, 0.4);
    expect(f.render).toHaveBeenLastCalledWith(
      f.term.wasmTerm,
      true,
      0,
      undefined,
      0.4,
    );
    expect(f.getViewport).toHaveBeenCalledTimes(3);
    dispose();
  });
});

describe("cursor activity", () => {
  const fixture = () => {
    const cursor = { x: 0, y: 0, visible: true };
    const term = {
      options: { cursorBlink: true },
      wasmTerm: { getCursor: () => cursor },
    };
    const activity = createTerminalCursorActivity(
      () => term as unknown as Terminal,
    );
    activity.reset();
    return { term, cursor, activity };
  };
  it("keeps the blink phase visible during typing and resumes only after 530ms idle", async () => {
    vi.useFakeTimers();
    const { term, activity } = fixture();
    activity.markActivity();
    expect(term.options.cursorBlink).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    activity.markActivity();
    await vi.advanceTimersByTimeAsync(529);
    expect(term.options.cursorBlink).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(term.options.cursorBlink).toBe(true);
    activity.dispose();
  });
  it("refreshes activity on horizontal/vertical output movement, not on stationary responses", async () => {
    vi.useFakeTimers();
    const { term, cursor, activity } = fixture();
    activity.markActivity();
    await vi.advanceTimersByTimeAsync(500);
    cursor.x = 1;
    activity.observeOutput();
    await vi.advanceTimersByTimeAsync(500);
    cursor.y = 1;
    activity.observeOutput();
    await vi.advanceTimersByTimeAsync(500);
    activity.observeOutput();
    expect(term.options.cursorBlink).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    expect(term.options.cursorBlink).toBe(true);
    activity.dispose();
  });
  it("respects application cursor visibility and cancels timers on reset/dispose", async () => {
    vi.useFakeTimers();
    const { term, cursor, activity } = fixture();
    cursor.visible = false;
    activity.markActivity();
    expect(cursor.visible).toBe(false);
    activity.reset();
    expect(term.options.cursorBlink).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    activity.markActivity();
    activity.dispose();
    expect(vi.getTimerCount()).toBe(0);
    activity.markActivity();
    await vi.runAllTimersAsync();
    expect(term.options.cursorBlink).toBe(true);
  });
  it("does not touch disposed WASM from late callbacks or repeated cleanup", () => {
    vi.useFakeTimers();
    const { term, activity } = fixture();
    activity.markActivity();
    activity.dispose();
    const getCursor = vi
      .spyOn(term.wasmTerm, "getCursor")
      .mockImplementation(() => {
        throw new Error("WASM terminal has been freed");
      });
    activity.observeOutput();
    activity.reset();
    activity.markActivity();
    activity.dispose();
    expect(getCursor).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
