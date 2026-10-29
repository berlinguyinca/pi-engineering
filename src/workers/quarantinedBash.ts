/**
 * Bash tool operations that register every command's process group with a ProcessQuarantine under the
 * execution's scope, so fencing the execution can terminate what its tools started. Behaviour otherwise follows
 * pi's local shell operations (detached group, streamed output, 128+signal exit codes, abort and timeout kill).
 */

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import type { ProcessQuarantine } from "./processQuarantine.ts";

export function createQuarantinedBashOperations(quarantine: ProcessQuarantine, scope: object): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      if (quarantine.isQuarantined(scope)) throw new Error("execution is quarantined; no new commands may start");
      const shell = getShellConfig();
      const viaStdin = shell.commandTransport === "stdin";
      const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, command], {
        cwd,
        detached: process.platform !== "win32",
        env: env ?? process.env,
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      if (viaStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }
      const pid = child.pid && process.platform !== "win32" ? child.pid : undefined;
      if (pid) quarantine.track(scope, { pid });
      // A command's own abort or timeout quarantines just its group: same SIGTERM, grace, SIGKILL.
      const stop = (): void => {
        if (!pid) return;
        const own = {};
        quarantine.track(own, { pid });
        void quarantine.quarantine(own);
      };
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (timeout !== undefined && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            stop();
          }, timeout * 1000);
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        if (signal) {
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        }
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (c) => {
            // Descendants may hold the stdio pipes open; do not wait for 'close' beyond a short drain.
            setTimeout(() => resolve(c), 50);
          });
        });
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        const sig = child.signalCode;
        return { exitCode: code ?? (sig ? 128 + (osConstants.signals[sig] ?? 0) : 1) };
      } finally {
        if (pid) quarantine.release(scope, pid);
        // The leader is gone. If descendants still run, the group stays tracked under the execution scope so a
        // later fence can still terminate it; quarantine() and track() prune groups that no longer exist.
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      }
    },
  };
}
