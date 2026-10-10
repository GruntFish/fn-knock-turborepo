// Real Ghostty/Canvas tests; no backend credentials needed for the default run.
// TERMINAL_TEST_BROWSER=chromium|firefox|webkit
// TERMINAL_TEST_RUNTIME=1 additionally starts an isolated macOS/Linux PTY backend.
// TERMINAL_TEST_SSH=1 also exercises a temporary loopback sshd (Unix, ssh-keygen required).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const require = createRequire(
  new URL("../apps/server-admin-view/package.json", import.meta.url),
);
const { createServer } = await import(
  pathToFileURL(require.resolve("vite")).href
);
const fixture = await readFile(
  new URL("./fixtures/terminal-performance-browser.js", import.meta.url),
  "utf8",
);
let runtime, browser, server, ssh;
try {
  if (
    process.env.TERMINAL_TEST_RUNTIME === "1" ||
    process.env.TERMINAL_TEST_SSH === "1"
  ) {
    const { startRuntime } = await import("./runtime-test-harness.mjs");
    runtime = await startRuntime({
      serverBinary:
        process.env.FN_KNOCK_RUNTIME_SERVER_BIN ??
        "apps/server-admin-rs/target/runtime-test/server-admin-rs",
      gatewayBinary: process.env.FN_KNOCK_RUNTIME_GATEWAY_BIN,
      runtimeTarget: process.platform === "darwin" ? "macos" : "linux",
      protectedAdmin: true,
      collectMetrics: false,
      tempPrefix: "terminal-perf-",
    });
  }
  server = await createServer({
    root: fileURLToPath(new URL("../apps/server-admin-view/", import.meta.url)),
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      ...(runtime ? { proxy: { "/api": runtime.adminUrl } } : {}),
    },
    plugins: [
      {
        name: "terminal-performance-fixture",
        configureServer(dev) {
          dev.middlewares.use(async (request, response, next) => {
            if (request.url !== "/__terminal-performance.html") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await dev.transformIndexHtml(
                request.url,
                '<html><body><div id="app"></div><script type="module" src="/__terminal-performance.js"></script></body></html>',
              ),
            );
          });
        },
        resolveId(id) {
          if (id === "/__terminal-performance.js") return "\0terminal-perf";
        },
        load(id) {
          if (id === "\0terminal-perf") return fixture;
        },
      },
    ],
  });
  await server.listen();
  const browserName = process.env.TERMINAL_TEST_BROWSER ?? "chromium";
  browser = await { chromium, firefox, webkit }[browserName].launch({
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1100 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}__terminal-performance.html`);
  await page.waitForFunction(() => window.terminalPerf);

  // Observe the real blink phase and actual canvas cursor paints. Private fields
  // are used only by this test, never by the production adapter.
  const cursor = await page.evaluate(async () => {
    const t = window.terminalPerf,
      term = t.emulator.getTerminal(),
      r = term.renderer;
    t.emulator.resetInputActivity();
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const check = () => {
        if (!r.cursorVisible) return resolve();
        if (performance.now() >= deadline)
          return reject(
            new Error("cursor never entered its hidden blink phase"),
          );
        setTimeout(check, 2);
      };
      check();
    });
    const original = r.renderCursor;
    let paintedAt = null;
    r.renderCursor = function (...args) {
      paintedAt ??= performance.now();
      return original.apply(this, args);
    };
    t.configure({ echo: true });
    const start = performance.now();
    term.element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "x",
        code: "KeyX",
        keyCode: 88,
        bubbles: true,
        cancelable: true,
      }),
    );
    const immediatelyVisible = r.cursorVisible;
    await t.queue.flushPendingInput();
    await new Promise(requestAnimationFrame);
    const result = {
      immediatelyVisible,
      painted: paintedAt !== null,
      paintDelayMs: paintedAt === null ? null : paintedAt - start,
    };
    r.renderCursor = original;
    t.configure({});
    return result;
  });
  assert.equal(cursor.immediatelyVisible, true);
  assert.equal(cursor.painted, true);
  console.log(JSON.stringify({ browser: browserName, cursor }));

  // All input sources use the same activity hook, including IME and toolbar/paste.
  await page.evaluate(async () => {
    const t = window.terminalPerf,
      term = t.emulator.getTerminal(),
      input = term.textarea;
    t.sent.length = 0;
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.value = "中文";
    input.dispatchEvent(
      new CompositionEvent("compositionend", { data: "中文", bubbles: true }),
    );
    input.value = "中文";
    input.dispatchEvent(
      new InputEvent("input", {
        data: "中文",
        inputType: "insertText",
        bubbles: true,
      }),
    );
    t.queue.queueTerminalInput("\x1b[D", { immediate: true });
    await t.queue.sendTerminalPayloadNow("paste");
    t.write("\x1b[?25l");
  });
  const inputResult = await page.evaluate(() => {
    const t = window.terminalPerf,
      term = t.emulator.getTerminal();
    return {
      input: new TextDecoder().decode(
        Uint8Array.from(t.sent.join(""), (c) => c.charCodeAt(0)),
      ),
      blink: term.options.cursorBlink,
      visible: Boolean(term.wasmTerm.getCursor().visible),
    };
  });
  assert.equal(inputResult.input, "中文\x1b[Dpaste");
  assert.equal(inputResult.blink, false);
  assert.equal(inputResult.visible, false);
  await page.waitForFunction(
    () => window.terminalPerf.emulator.getTerminal().options.cursorBlink,
  );
  await page.evaluate(() => window.terminalPerf.write("\x1b[?25h"));

  // A hidden cursor must disappear from the canvas, not just from WASM state.
  assert.equal(
    await page.evaluate(() => {
      const t = window.terminalPerf,
        term = t.emulator.getTerminal(),
        renderer = term.renderer;
      t.emulator.clearTerminal();
      t.queue.queueTerminalInput("x");
      renderer.render(term.wasmTerm, true, 0, term, 0);
      t.write("\x1b[?25l");
      renderer.render(term.wasmTerm, false, 0, term, 0);
      const canvas = term.element.querySelector("canvas");
      const context = canvas.getContext("2d");
      const pixels = () =>
        Array.from(context.getImageData(0, 0, 10, 10).data).join(",");
      const hidden = pixels();
      renderer.render(term.wasmTerm, true, 0, term, 0);
      return hidden === pixels();
    }),
    true,
    "hiding the cursor during input must erase its painted pixels",
  );

  // Single render scopes are invalidated on screen changes, resize and reset;
  // compare actual cells, not just read counts.
  assert.deepEqual(
    await page.evaluate(() => {
      const t = window.terminalPerf,
        term = t.emulator.getTerminal();
      t.emulator.clearTerminal();
      t.write("MAIN 中文\r\nline two");
      term.select(0, 0, 4);
      const selected = term.getSelection();
      term.clearSelection();
      t.write("\x1b[?1049h\x1b[HEDIT");
      term.resize(100, 30);
      term.renderer.render(term.wasmTerm, true, 0, term, 0);
      const alt = term.wasmTerm
        .getLine(0)
        .slice(0, 4)
        .map((c) => String.fromCodePoint(c.codepoint))
        .join("");
      t.write("\x1b[?1049l");
      term.options.fontSize = 16;
      const main = t.emulator.getTerminalText();
      t.write(
        "\r\n" +
          Array.from({ length: 100 }, (_, i) => `history ${i}\r\n`).join(""),
      );
      term.scrollLines(-10);
      term.renderer.render(term.wasmTerm, false, term.viewportY, term, 0);
      term.scrollToBottom();
      t.emulator.clearTerminal();
      t.write("RESET");
      term.renderer.render(term.wasmTerm, true, 0, term, 0);
      return {
        selected,
        alt,
        main: main.includes("MAIN 中文"),
        reset: t.emulator.getTerminalText().trim(),
      };
    }),
    { selected: "MAIN", alt: "EDIT", main: true, reset: "RESET" },
  );

  if (!runtime) {
    const measurements = await page.evaluate(() =>
      window.terminalPerf.benchmark(),
    );
    for (const result of measurements)
      assert.equal(result.cached.viewportReads, 1);
    console.log(JSON.stringify({ browser: browserName, measurements }));
    // Timing is an explicit acceptance mode so unrelated CI host contention does
    // not make correctness tests flaky. Always print raw before/after samples.
    if (process.env.TERMINAL_TEST_PERF_GATE === "1") {
      const medium = measurements.find((item) => item.cols === 200);
      assert.ok(
        medium.cached.p50Ms <= medium.baseline.p50Ms * 0.7,
        "200x60 median must improve by at least 30%",
      );
    }
  }
  if (runtime) {
    await page.evaluate(async () => {
      for (const route of ["password", "login"]) {
        const response = await fetch(`/api/admin/panel/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password: "terminal-test-password-123",
            rememberMe: false,
          }),
        });
        if (!response.ok) throw new Error(await response.text());
      }
    });
    if (process.env.TERMINAL_TEST_SSH === "1") {
      const { startTerminalTestSshd } =
        await import("./fixtures/terminal-test-sshd.mjs");
      ssh = await startTerminalTestSshd();
    }
    for (const transport of ssh ? ["local", "ssh"] : ["local"]) {
      if (transport === "local")
        await page.evaluate(() => window.terminalPerf.startLocal());
      else
        await page.evaluate(
          (connection) => window.terminalPerf.startSsh(connection),
          ssh.connection,
        );
      await page.waitForFunction(() => window.terminalPerf.readyForInput());
      // Both editors operate on unnamed buffers in an isolated runtime; no user files.
      await page.evaluate(() =>
        window.terminalPerf.queue.sendTerminalPayloadNow(
          "env TERM=xterm-256color vim -Nu NONE -n -i NONE\r",
        ),
      );
      await page.waitForFunction(() =>
        window.terminalPerf.emulator.getTerminal().wasmTerm.isAlternateScreen(),
      );
      await page.evaluate(() =>
        window.terminalPerf.queue.sendTerminalPayloadNow(
          "i" + "X".repeat(100) + "VIM-INPUT-中文Z\x7f\x1b",
        ),
      );
      await page.waitForFunction(() =>
        window.terminalPerf.emulator
          .getTerminalText()
          .includes("VIM-INPUT-中文"),
      );
      await page.evaluate(() =>
        window.terminalPerf.queue.sendTerminalPayloadNow("0"),
      );
      await page.waitForFunction(
        () =>
          window.terminalPerf.emulator.getTerminal().wasmTerm.getCursor().x ===
          0,
      );
      const pressure = await page.evaluate(async () => {
        const t = window.terminalPerf;
        t.configure({ delayMs: 80 });
        t.samples.length = 0;
        let lastKeyAt = 0;
        await new Promise((resolve) => {
          for (let i = 0; i < 60; i++)
            setTimeout(
              () => {
                lastKeyAt = performance.now();
                t.emulator.getTerminal().element.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "ArrowRight",
                    code: "ArrowRight",
                    keyCode: 39,
                    bubbles: true,
                    cancelable: true,
                  }),
                );
                if (i === 59) resolve();
              },
              (i * 1000) / 30,
            );
        });
        await t.queue.flushPendingInput();
        const result = {
          keys: 60,
          delayMs: 80,
          requests: t.samples.filter((s) => s.stage === "inputRequest").length,
          drainAfterLastKeyMs: performance.now() - lastKeyAt,
        };
        t.configure({});
        return result;
      });
      await page.waitForFunction(
        () =>
          window.terminalPerf.emulator.getTerminal().wasmTerm.getCursor().x ===
          60,
      );
      assert.ok(
        pressure.requests < 35,
        "repeat keys must coalesce while requests are pending",
      );
      assert.ok(
        pressure.drainAfterLastKeyMs < 500,
        "input must not build a seconds-long backlog",
      );
      console.log(
        JSON.stringify({ browser: browserName, transport, pressure }),
      );
      await page.evaluate(() =>
        window.terminalPerf.queue.sendTerminalPayloadNow(":q!\r"),
      );
      await page.waitForFunction(
        () =>
          !window.terminalPerf.emulator
            .getTerminal()
            .wasmTerm.isAlternateScreen(),
      );
      await page.evaluate(() =>
        window.terminalPerf.queue.sendTerminalPayloadNow(
          "env TERM=xterm-256color nano\r",
        ),
      );
      await page.waitForFunction(() =>
        window.terminalPerf.emulator.getTerminalText().includes("Write"),
      );
      await page.evaluate(() =>
        window.terminalPerf.queue.sendTerminalPayloadNow("NANO-INPUT-中文"),
      );
      await page.waitForFunction(() =>
        window.terminalPerf.emulator
          .getTerminalText()
          .includes("NANO-INPUT-中文"),
      );
      await page.evaluate(() =>
        window.terminalPerf.queue.sendTerminalPayloadNow("\x18n"),
      );
      console.log(
        JSON.stringify({
          browser: browserName,
          transport,
          editors: "vim/nano passed",
          samples: await page.evaluate(() =>
            window.terminalPerf.samples.slice(-12),
          ),
        }),
      );
      await page.evaluate(() => window.terminalPerf.stopBackend());
    }
  }
  await page.evaluate(() => window.terminalPerf.emulator.dispose());
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server?.close();
  await runtime?.stop();
  await ssh?.stop();
}
