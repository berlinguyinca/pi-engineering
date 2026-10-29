/**
 * Runaway process quarantine.
 *
 * A fenced lease or a stale execution stops the *logical* writer from publishing, but it does not stop an OS
 * process the worker already started (a hung test run, a dev server, a loop in a shell tool). This registry
 * remembers the process groups each execution scope started and terminates exactly those groups on demand:
 * SIGTERM to the group, a grace period, then SIGKILL.
 *
 * Safety properties (all covered by tests with a fake process table):
 *  - only groups that were registered for the scope are ever signalled; nothing is discovered by scanning;
 *  - pid <= 1 and this process's own pid / process group are refused at registration;
 *  - a handle that already exited is never signalled (its pid may have been recycled);
 *  - once a scope is quarantined, a group registered afterwards is killed immediately, so a fenced worker
 *    cannot start new long-running commands.
 *
 * Limits: a descendant that left the group (setsid, double fork into a new session) is not reachable by group
 * signalling; Windows has no process groups and is not handled here.
 */

import { readFileSync } from "node:fs";

export interface ProcessHandle {
  /** Process group leader pid; the child must have been spawned `detached` so pgid === pid. */
  pid: number;
}

export interface ProcessOps {
  /** `process.kill`. A negative pid addresses the process group; signal 0 probes. Throws ESRCH when gone. */
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  sleep(ms: number): Promise<void>;
  /** Pids that must never be signalled (this process and its group). */
  protectedPids(): readonly number[];
  /** Start-time fingerprint of a pid (Linux /proc); null when the process is gone or unsupported. */
  fingerprint?(pid: number): string | null;
}

export interface QuarantineOptions {
  /** Time between SIGTERM and SIGKILL. Default 5000. */
  graceMs?: number;
  /** Poll interval while waiting for a group to exit. Default 50. */
  pollMs?: number;
  /** Time to wait for a group to disappear after SIGKILL. Default 2000. */
  killWaitMs?: number;
  ops?: ProcessOps;
}

export interface QuarantineReport {
  /** Groups that were gone within the grace period after SIGTERM. */
  terminated: number[];
  /** Groups that needed SIGKILL. */
  killed: number[];
  /** Groups still present after SIGKILL and the wait (unkillable, or a different owner). */
  survivors: number[];
  /** Registered groups that no longer existed when quarantined; not signalled. */
  alreadyExited: number[];
}

const systemOps: ProcessOps = {
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  protectedPids: () => [process.pid, process.ppid],
  fingerprint: (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      return null;
    }
  },
};

interface ScopeState {
  groups: Map<number, ProcessHandle & { start: string | null }>;
  quarantined: boolean;
}

export class ProcessQuarantine {
  private readonly scopes = new WeakMap<object, ScopeState>();
  private readonly graceMs: number;
  private readonly pollMs: number;
  private readonly killWaitMs: number;
  private readonly ops: ProcessOps;

  constructor(opts: QuarantineOptions = {}) {
    this.graceMs = opts.graceMs ?? 5_000;
    this.pollMs = opts.pollMs ?? 50;
    this.killWaitMs = opts.killWaitMs ?? 2_000;
    this.ops = opts.ops ?? systemOps;
  }

  private state(scope: object): ScopeState {
    let s = this.scopes.get(scope);
    if (!s) {
      s = { groups: new Map(), quarantined: false };
      this.scopes.set(scope, s);
    }
    return s;
  }

  /**
   * Register a process group for `scope` (typically the execution's AbortSignal). Returns an `untrack` function to
   * call when the process exits normally. Throws for a pid that must never be signalled.
   */
  track(scope: object, handle: ProcessHandle): () => void {
    const { pid } = handle;
    if (!Number.isInteger(pid) || pid <= 1 || this.ops.protectedPids().includes(pid)) {
      throw new Error(`refusing to track protected or invalid pid ${pid}`);
    }
    const s = this.state(scope);
    for (const [other] of s.groups) if (!this.groupAlive(other)) s.groups.delete(other);
    s.groups.set(pid, { ...handle, start: this.ops.fingerprint?.(pid) ?? null });
    if (s.quarantined) void this.quarantine(scope);
    return () => this.release(scope, pid);
  }

  /** Stop tracking a group once it is gone. A group that still has members (a backgrounded descendant) stays tracked. */
  release(scope: object, pid: number): void {
    const s = this.scopes.get(scope);
    if (s && !this.groupAlive(pid)) s.groups.delete(pid);
  }

  /** Currently registered group leaders for the scope. */
  tracked(scope: object): number[] {
    return [...(this.scopes.get(scope)?.groups.keys() ?? [])];
  }

  isQuarantined(scope: object): boolean {
    return this.scopes.get(scope)?.quarantined === true;
  }

  private groupAlive(pid: number): boolean {
    try {
      this.ops.kill(-pid, 0);
      return true;
    } catch (error) {
      // EPERM means the group exists but is not ours to signal: report it as a survivor, not as gone.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private async waitGone(pid: number, ms: number): Promise<boolean> {
    let waited = 0;
    while (this.groupAlive(pid)) {
      if (waited >= ms) return false;
      const step = Math.min(this.pollMs, ms - waited);
      await this.ops.sleep(step);
      waited += step;
    }
    return true;
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.ops.kill(-pid, signal);
    } catch {
      // ESRCH: already gone. EPERM: not ours; the survivor report names it.
    }
  }

  /** SIGTERM, grace, SIGKILL every group registered for `scope`, and refuse new ones from now on. */
  async quarantine(scope: object): Promise<QuarantineReport> {
    const s = this.state(scope);
    s.quarantined = true;
    const report: QuarantineReport = { terminated: [], killed: [], survivors: [], alreadyExited: [] };
    const handles = [...s.groups.values()];
    await Promise.all(
      handles.map(async ({ pid, start }) => {
        // A leader that is still there with a different start time means the pid was recycled: not ours.
        const now = start === null ? null : (this.ops.fingerprint?.(pid) ?? null);
        const recycled = now !== null && now !== start;
        if (recycled || !this.groupAlive(pid)) {
          s.groups.delete(pid);
          report.alreadyExited.push(pid);
          return;
        }
        this.signal(pid, "SIGTERM");
        if (await this.waitGone(pid, this.graceMs)) {
          report.terminated.push(pid);
        } else {
          this.signal(pid, "SIGKILL");
          if (await this.waitGone(pid, this.killWaitMs)) report.killed.push(pid);
          else {
            report.survivors.push(pid);
            return; // stays tracked so a later quarantine retries it
          }
        }
        s.groups.delete(pid);
      }),
    );
    return report;
  }
}

/** The process-wide registry shared by the worker executor and the broker. */
export const sharedProcessQuarantine = new ProcessQuarantine();
