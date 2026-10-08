/**
 * Backoff for supervisor-driven repairs (session review).
 *
 * The supervisor ticks every 30s. A mission whose repair decision does not
 * change — the repair ran, made no material progress, and the same decision is
 * reported again — was repaired on every tick, each time acquiring the mission
 * lease and writing fence events. The same unchanged decision is now retried
 * with exponential spacing; any change to the decision, mission status or
 * blocked episode retries immediately.
 */

export interface SupervisorRepairBackoffOptions {
  /** Delay after the first unproductive attempt. */
  baseMs?: number;
  /** Ceiling on the delay. */
  maxMs?: number;
}

interface Entry {
  fingerprint: string;
  attempts: number;
  lastAt: number;
}

export class SupervisorRepairBackoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: SupervisorRepairBackoffOptions = {}) {
    this.baseMs = options.baseMs ?? 30_000;
    this.maxMs = options.maxMs ?? 30 * 60_000;
  }

  /** Delay owed after `attempts` consecutive attempts of one fingerprint. */
  private delayAfter(attempts: number): number {
    return Math.min(this.maxMs, this.baseMs * 2 ** Math.max(0, attempts - 1));
  }

  shouldAttempt(missionId: string, fingerprint: string, now: number): boolean {
    const entry = this.entries.get(missionId);
    if (!entry || entry.fingerprint !== fingerprint) return true;
    return now - entry.lastAt > this.delayAfter(entry.attempts);
  }

  recordAttempt(missionId: string, fingerprint: string, now: number): void {
    const entry = this.entries.get(missionId);
    const attempts = entry && entry.fingerprint === fingerprint ? entry.attempts + 1 : 1;
    this.entries.set(missionId, { fingerprint, attempts, lastAt: now });
  }

  forget(missionId: string): void {
    this.entries.delete(missionId);
  }
}
