// Loopback-only SSH fixture. Uses temporary host/authorized keys, never ~/.ssh.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";

export async function startTerminalTestSshd() {
  const directory = await mkdtemp(path.join(tmpdir(), "terminal-sshd-"));
  const exec = promisify(execFile);
  let child;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const listener = net.createServer();
      listener.on("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const port = listener.address().port;
        listener.close(() => resolve(port));
      });
    });
    for (const name of ["host", "client"])
      await exec("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        path.join(directory, name),
      ]);
    const username = userInfo().username;
    await writeFile(
      path.join(directory, "config"),
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${directory}/host`,
        `PidFile ${directory}/pid`,
        `AuthorizedKeysFile ${directory}/client.pub`,
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        `AllowUsers ${username}`,
        "LogLevel ERROR",
        "AcceptEnv LANG LC_*",
      ].join("\n") + "\n",
    );
    child = spawn(
      "/usr/sbin/sshd",
      ["-D", "-e", "-f", path.join(directory, "config")],
      { detached: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-4000);
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`sshd readiness timeout: ${errors}`));
      }, 5000);
      let retry;
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const exited = () => fail(new Error(`sshd exited: ${errors}`));
      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(retry);
        child.off("error", fail);
        child.off("exit", exited);
      };
      child.once("error", fail);
      child.once("exit", exited);
      const probe = () => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          cleanup();
          resolve();
        });
        socket.once("error", () => {
          socket.destroy();
          retry = setTimeout(probe, 50);
        });
      };
      probe();
    });
    return {
      connection: {
        host: "127.0.0.1",
        port,
        username,
        secret: await readFile(path.join(directory, "client"), "utf8"),
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
