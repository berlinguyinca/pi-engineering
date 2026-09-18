/**
 * CAV-03 Real Stack Lifecycle: start/stop/health-check a real deployed
 * development stack with deterministic, fail-closed evidence.
 *
 * Reconciles with the existing control-plane HTTP server (scripts/
 * control-server.ts). This harness starts the real server as a child process,
 * polls its /health endpoint until it reports ok, runs the caller's
 * verification, then stops it. A real process, a real HTTP round-trip, and a
 * real health payload are the evidence — not a mock.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

export interface StackLifecycleOptions {
  command: string;
  args: string[];
  cwd: string;
  healthUrl: string;
  /** Max time to wait for a healthy response (ms). */
  startupTimeoutMs?: number;
  /** Injectable poll interval (ms). */
  pollMs?: number;
  /** Injectable fetch (deterministic in tests). */
  fetchImpl?: typeof fetch;
}

export interface StackLifecycleResult {
  started: boolean;
  healthy: boolean;
  healthBody: string;
  stopped: boolean;
  /** Child stderr captured during startup (for diagnostics). */
  startupStderr: string;
  startupMs: number;
}

export class StackLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackLifecycleError";
  }
}

/** Wait until the health endpoint returns 200 (or timeout). */
async function waitHealthy(
  url: string,
  timeoutMs: number,
  pollMs: number,
  fetchImpl: typeof fetch,
): Promise<{ healthy: boolean; body: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastBody = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url);
      lastBody = await res.text();
      if (res.ok) return { healthy: true, body: lastBody };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { healthy: false, body: lastBody };
}

/**
 * Start the stack, wait for health, run verification, then always stop.
 * Fails closed: if the process cannot start or never becomes healthy, it is
 * stopped and an error is thrown (no PASS can be recorded).
 */
export async function runRealStackLifecycle(
  opts: StackLifecycleOptions,
  verify: () => Promise<void>,
): Promise<StackLifecycleResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 20_000;
  const pollMs = opts.pollMs ?? 300;

  let child: ChildProcess | undefined;
  let startupStderr = "";
  let spawnError: Error | null = null;
  const onSpawnError = (e: Error): void => {
    spawnError = e;
  };
  try {
    const cleanEnv = { ...process.env, NODE_TEST_CONTEXT: "" };
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: cleanEnv,
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    child.unref();
    child.on("error", onSpawnError);
    child.stderr?.on("data", (d) => {
      startupStderr = `${startupStderr}${String(d)}`.slice(-2000);
    });
    // A failed spawn surfaces asynchronously; give it a beat before health polling.
    await new Promise((r) => setTimeout(r, 150));
    const err = (spawnError as Error | null) ?? null;
    if (err) {
      throw new StackLifecycleError(`failed to start stack: ${err.message}`);
    }
    const start = Date.now();
    const { healthy, body } = await waitHealthy(opts.healthUrl, startupTimeoutMs, pollMs, fetchImpl);
    const startupMs = Date.now() - start;
    if (!healthy) {
      throw new StackLifecycleError(`stack did not become healthy within ${startupTimeoutMs}ms`);
    }
    await verify();
    return {
      started: true,
      healthy: true,
      healthBody: body,
      stopped: await stop(child),
      startupStderr,
      startupMs,
    };
  } finally {
    if (child && child.exitCode === null) {
      await stop(child);
    }
  }
}

/** True if the process group no longer exists. */
function groupGone(pid: number): boolean {
  if (pid <= 0) return true;
  try {
    // kill(pid, 0) probes existence without sending a signal.
    process.kill(-pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function stop(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (child.exitCode !== null && (pid ? groupGone(pid) : true)) return true;
  // Kill the whole process group (the node launcher may fork a grandchild that
  // actually hosts the server). Negative pid targets the group (detached).
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((r) => setTimeout(r, 800));
  if (pid && !groupGone(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  // Stopped means: process group gone (or child exited).
  return child.exitCode !== null || (pid ? groupGone(pid) : false);
}
