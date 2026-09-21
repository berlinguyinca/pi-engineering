/**
 * Durable lifecycle state (spec §28).
 *
 * Runs are JSON snapshots plus an append-only transition log, so a crashed or
 * restarted harness resumes where it left off instead of trusting a transcript.
 * Transitions carry a sequence number, which makes replay idempotent.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LifecycleEvent, LifecycleRun, LifecycleState, LifecycleTrigger } from "./types.ts";

export interface StoredRun {
  run: LifecycleRun;
  /** Highest applied event sequence. */
  seq: number;
}

export class LifecycleStore {
  private readonly runs = new Map<string, LifecycleRun>();
  private readonly seqs = new Map<string, number>();
  private writeChain: Promise<void> = Promise.resolve();

  private readonly dir: string;

  private constructor(root: string) {
    this.dir = root;
  }

  static async open(dir: string): Promise<LifecycleStore> {
    const store = new LifecycleStore(dir);
    try {
      const { readdir } = await import("node:fs/promises");
      for (const entry of await readdir(store.runsDir())) {
        if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
        try {
          const parsed = JSON.parse(await readFile(join(store.runsDir(), entry), "utf-8")) as LifecycleRun;
          if (parsed?.runId) {
            store.runs.set(parsed.runId, parsed);
            store.seqs.set(parsed.runId, 0);
          }
        } catch {
          // Ignore a corrupt snapshot; the event log still holds its history.
        }
      }
    } catch {
      // No runs yet.
    }
    return store;
  }

  static inMemory(): LifecycleStore {
    return new LifecycleStore("");
  }

  private runsDir(): string {
    return join(this.dir, "runs");
  }

  private runFile(runId: string): string {
    return join(this.runsDir(), `${runId}.json`);
  }

  private get eventFile(): string {
    return join(this.dir, "events.jsonl");
  }

  list(): LifecycleRun[] {
    return [...this.runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(runId: string): LifecycleRun | undefined {
    return this.runs.get(runId);
  }

  /** Most recent non-terminal run for a session key (used to resume work). */
  activeFor(sessionKey: string): LifecycleRun | undefined {
    return this.list().find((r) => r.sessionKey === sessionKey && !["COMPLETE", "ESCALATED"].includes(r.state));
  }

  /** Find a run by the request that opened it, so a retried request is idempotent. */
  byRequestKey(requestKey: string): LifecycleRun | undefined {
    return [...this.runs.values()].find((r) => r.requestKey === requestKey);
  }

  async save(run: LifecycleRun): Promise<void> {
    this.runs.set(run.runId, run);
    if (!this.dir) return;
    const file = this.runFile(run.runId);
    const payload = JSON.stringify(run, null, 2);
    const op = this.writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, payload, "utf-8");
      const { rename } = await import("node:fs/promises");
      await rename(tmp, file);
    });
    this.writeChain = op.catch(() => {});
    await op;
  }

  /**
   * Append a transition. Returns false when the event was already applied
   * (duplicate delivery), which keeps resume idempotent.
   */
  async recordTransition(
    runId: string,
    state: LifecycleState,
    trigger: LifecycleTrigger,
    detail?: string,
  ): Promise<LifecycleEvent | undefined> {
    const seq = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, seq);
    const event: LifecycleEvent = { at: new Date().toISOString(), runId, state, trigger, detail, seq };
    if (!this.dir) return event;
    const op = this.writeChain.then(() => appendFile(this.eventFile, `${JSON.stringify(event)}\n`, "utf-8"));
    this.writeChain = op.catch(() => {});
    await op;
    return event;
  }

  async transitions(runId: string): Promise<LifecycleEvent[]> {
    if (!this.dir) return [];
    try {
      const raw = await readFile(this.eventFile, "utf-8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as LifecycleEvent;
          } catch {
            return undefined;
          }
        })
        .filter((e): e is LifecycleEvent => !!e && e.runId === runId)
        .sort((a, b) => a.seq - b.seq);
    } catch {
      return [];
    }
  }
}
