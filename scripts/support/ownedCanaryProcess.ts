import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export interface OwnedCanaryProcess {
  child: ChildProcess;
  readonly closed: boolean;
  readonly error: Error | undefined;
  closedPromise: Promise<void>;
}

/** Install immediately after spawn: failed spawns emit error/close without exit. */
export function trackOwnedCanaryProcess(child: ChildProcess): OwnedCanaryProcess {
  let closed = false;
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closedPromise = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  return {
    child,
    get closed() {
      return closed;
    },
    get error() {
      return spawnError;
    },
    closedPromise,
  };
}

async function waitForClose(process: OwnedCanaryProcess, timeoutMs: number): Promise<boolean> {
  if (process.closed) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.closedPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only accepts processes the canary spawned with detached:true (its own process groups). */
export async function stopOwnedCanaryProcess(process: OwnedCanaryProcess | undefined, graceMs = 5000): Promise<void> {
  if (!process || process.closed) return;
  const signal = (kind: NodeJS.Signals) => {
    if (process.child.pid === undefined || process.closed) return;
    try {
      globalThis.process.kill(-process.child.pid, kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  if (await waitForClose(process, graceMs)) return;
  signal("SIGKILL");
  if (!(await waitForClose(process, graceMs))) throw new Error("Owned canary process did not close after shutdown");
}

export async function cleanupOwnedCanary(options: {
  client?: OwnedCanaryProcess;
  server?: OwnedCanaryProcess;
  root: string;
  sessionDirectory: string;
  ownsSessionDirectory: boolean;
  graceMs?: number;
}): Promise<void> {
  try {
    // A client must close first to prevent empty-session fallback during server shutdown.
    await stopOwnedCanaryProcess(options.client, options.graceMs);
    await stopOwnedCanaryProcess(options.server, options.graceMs);
    await rm(options.root, { recursive: true, force: true });
    if (options.ownsSessionDirectory) await rm(options.sessionDirectory, { recursive: true, force: true });
  } finally {
    // Credential copies must be removed even when shutdown fails; leave live server resources intact.
    await rm(join(options.root, "profile"), { recursive: true, force: true });
  }
}
