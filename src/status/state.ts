/**
 * Harness runtime telemetry state — the structured, reusable model behind the
 * live status footer.
 *
 * This is the first user-visible surface of the pi-engineering-harness runtime
 * telemetry layer. The footer renders *from* this state; it does not rediscover
 * everything itself. The same state is meant to be consumed later by
 * subprocess/subagent orchestration, dashboards, logs, and aggregate telemetry —
 * see `WorkerStatus` below, which is the schema the aggregate footer can show
 * (e.g. `⚡247 t/s Σ │ main 82 │ workers:3`) without rewriting the single-process
 * throughput tracker.
 */

export type ThroughputPhase = "idle" | "streaming" | "waiting" | "unavailable";

export interface ThroughputState {
  phase: ThroughputPhase;
  /** Current rolling tokens/sec (streaming only). */
  currentTokensPerSecond?: number;
  /** Last completed generation's authoritative tokens/sec, kept while idle. */
  lastCompletedTokensPerSecond?: number;
  /** Cumulative output tokens for the active (or last) generation. */
  outputTokens?: number;
}

export interface HarnessStatusState {
  /** Process/active working directory. */
  cwd: string;
  /** Canonical repository identity `owner/repo` (or root basename). */
  repository?: string;
  /** Absolute path of the repository root (git toplevel). */
  repositoryRoot?: string;
  /** Short worktree label, e.g. `wt:feature-routing` (linked worktrees only). */
  worktree?: string;
  /** Current branch name. */
  branch?: string;
  /** Short commit SHA when HEAD is detached. */
  detachedHead?: string;
  /** Active model id. */
  model?: string;
  /** Active model provider. */
  provider?: string;
  /** Live throughput telemetry. */
  throughput: ThroughputState;
}

/** Schema for future subprocess/subagent telemetry contribution. */
export interface WorkerStatus {
  id: string;
  kind: "main" | "subprocess" | "subagent";
  model?: string;
  tokensPerSecond?: number;
  state: string;
  worktree?: string;
  branch?: string;
}

export type StatusListener = (state: Readonly<HarnessStatusState>) => void;

/**
 * Lightweight observable status state. Notifies subscribers on `set`.
 * Returns an unsubscribe from `subscribe`, so listeners are always cleaned up.
 */
export class StatusState {
  private state: HarnessStatusState;
  private readonly listeners = new Set<StatusListener>();
  private disposed = false;

  constructor(init?: Partial<HarnessStatusState>) {
    this.state = {
      cwd: "",
      throughput: { phase: "unavailable" },
      ...init,
    };
  }

  get snapshot(): Readonly<HarnessStatusState> {
    return this.state;
  }

  /** Merge a partial patch and notify subscribers. No-op when nothing changed. */
  set(patch: Partial<HarnessStatusState>): void {
    if (this.disposed) return;
    const next: HarnessStatusState = { ...this.state, ...patch };
    if (deepEqual(this.state, next)) return;
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // A misbehaving listener must never break the status bar.
      }
    }
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

function deepEqual(a: HarnessStatusState, b: HarnessStatusState): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
