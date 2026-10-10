import { createApp, h, onMounted, ref } from "vue";
import { useTerminalEmulator } from "/src/views/web-terminal/useTerminalEmulator.ts";
import { useTerminalInputQueue } from "/src/views/web-terminal/useTerminalInputQueue.ts";
import { useTerminalAttachment } from "/src/views/web-terminal/useTerminalAttachment.ts";
import { TerminalAPI } from "/src/lib/api/terminal.ts";
import { ensureGhostty } from "/src/views/web-terminal/terminal-runtime.ts";
import { bindTerminalRenderCache } from "/src/views/web-terminal/terminal-render-cache.ts";

createApp({
  setup() {
    const frame = ref(null),
      sent = [],
      samples = [];
    let sshTarget = null;
    let delayMs = 0,
      echo = false,
      cursor = 0,
      backend = false;
    const attachment = ref({ id: "probe", generation: 1 });
    const controller = useTerminalAttachment({
      getTerminalSize: () => emulator.getTerminalSize(),
      onOutput: (event) => {
        const start = performance.now();
        emulator.applyOutputEvent(event);
        samples.push({
          stage: "output",
          durationMs: performance.now() - start,
        });
      },
      onReset: () => emulator.clearTerminal(),
      onSessionState() {},
    });
    const queue = useTerminalInputQueue({
      activeAttachment: attachment,
      connectionState: ref("connected"),
      selectedSessionId: ref("probe"),
      onSendError: (error) => {
        throw error;
      },
      onUserInput: () => emulator.markInputActivity(),
      translate: (key) => key,
      sendInput: async (_id, data) => {
        const startedAt = performance.now();
        sent.push(atob(data));
        if (delayMs)
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (backend) await controller.sendInput(data);
        else if (echo)
          write(
            new TextDecoder().decode(
              Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
            ),
          );
        samples.push({
          stage: "inputRequest",
          startedAt,
          durationMs: performance.now() - startedAt,
        });
      },
    });
    const emulator = useTerminalEmulator({
      applyFontSize() {},
      canAcceptInput: () => true,
      compactViewport: ref(false),
      persistFontSize() {},
      queueInput: queue.queueTerminalInput,
      queueRemoteResponse: queue.queueRemoteTerminalResponse,
      scheduleResize() {},
      terminalFontSize: ref(14),
      terminalFrameRef: frame,
      translate: (key) => key,
    });
    const write = (text) =>
      emulator.applyOutputEvent({
        type: "output",
        cursor: ++cursor,
        dataBase64: btoa(
          Array.from(new TextEncoder().encode(text), (byte) =>
            String.fromCharCode(byte),
          ).join(""),
        ),
        reset: false,
      });
    onMounted(async () => {
      await emulator.ensureTerminalReady();
      emulator.clearTerminal();
      window.terminalPerf = {
        emulator,
        queue,
        sent,
        samples,
        write,
        configure: (options) => {
          delayMs = options.delayMs ?? 0;
          echo = options.echo ?? false;
        },
        async startLocal() {
          const status = await TerminalAPI.getLocalStatus();
          await TerminalAPI.updateLocalStatus({
            enabled: true,
            revision: status.revision,
            acknowledgeRisk: true,
          });
          const session = await TerminalAPI.createLocalSession({
            ...emulator.getTerminalSize(),
          });
          backend = true;
          await controller.attach(session);
          attachment.value = controller.attachment.value;
          return session.id;
        },
        async startSsh({ host, port, username, secret }) {
          const trustedHostKey = await TerminalAPI.probeHostKey({ host, port });
          const draft = {
            host,
            port,
            username,
            authMethod: "privateKey",
            trustedHostKey,
          };
          const credential = { action: "replace", secret },
            passphrase = { action: "clear" };
          const tested = await TerminalAPI.testConnection({
            draft,
            credential,
            passphrase,
          });
          sshTarget = await TerminalAPI.createTarget({
            ...draft,
            credential,
            passphrase,
            name: "Performance fixture",
            verificationToken: tested.verificationToken,
          });
          const session = await TerminalAPI.createSession(
            sshTarget.id,
            emulator.getTerminalSize(),
          );
          backend = true;
          samples.length = 0;
          await controller.attach(session);
          attachment.value = controller.attachment.value;
        },
        async stopBackend() {
          const id = controller.sessionId.value;
          queue.clearPendingInput();
          await controller.detach();
          if (id) await TerminalAPI.deleteSession(id);
          if (sshTarget) {
            await TerminalAPI.deleteTarget(sshTarget.id, sshTarget.revision);
            sshTarget = null;
          }
          backend = false;
        },
        readyForInput: () => controller.canInput.value,
        async benchmark() {
          const { Terminal, ghostty } = await ensureGhostty();
          const result = [];
          for (const [cols, rows] of [
            [120, 32],
            [200, 60],
            [300, 100],
          ]) {
            const mount = document.createElement("div");
            document.body.append(mount);
            const term = new Terminal({
              ghostty,
              cols,
              rows,
              fontSize: 14,
              cursorBlink: true,
              fontFamily:
                '"SFMono-Regular", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace',
            });
            term.open(mount);
            const renderer = term.renderer,
              wasm = term.wasmTerm;
            const original = wasm.getViewport;
            let reads = 0;
            wasm.getViewport = function () {
              reads++;
              return original.call(wasm);
            };
            const screen =
              "\x1b[?1049h\x1b[H\x1b[2J" +
              Array.from(
                { length: rows },
                (_, y) =>
                  `\x1b[${y + 1};1H${"text syntax 1234 ".repeat(30).slice(0, cols - 1)}`,
              ).join("");
            const stats = { cols, rows };
            for (const mode of ["baseline", "cached"]) {
              const unbind =
                mode === "cached" ? bindTerminalRenderCache(term) : () => {};
              const times = [];
              for (let i = 0; i < 60; i++) {
                term.write(screen);
                reads = 0;
                const start = performance.now();
                renderer.render(wasm, false, 0, term, 0);
                if (i >= 15) times.push(performance.now() - start);
              }
              times.sort((a, b) => a - b);
              stats[mode] = {
                p50Ms: times[Math.floor(times.length / 2)],
                p95Ms: times[Math.floor(times.length * 0.95)],
                viewportReads: reads,
              };
              unbind();
            }
            term.dispose();
            mount.remove();
            result.push(stats);
          }
          emulator.focusTerminal();
          return result;
        },
      };
    });
    return () =>
      h(
        "div",
        { ref: frame, style: "position:relative;width:1100px;height:600px" },
        [
          h("div", {
            id: "terminal",
            ref: emulator.terminalMountRef,
            style: "width:100%;height:100%",
          }),
        ],
      );
  },
}).mount("#app");
