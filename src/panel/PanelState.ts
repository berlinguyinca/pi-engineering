/**
 * Panel state — the structured model behind the engineering overlay.
 *
 * The same split the status footer uses (`src/status/state.ts`): this object
 * holds data, feeders fill it, and the component only paints it. Keeping the
 * state observable and the rendering dumb is what lets the interesting
 * behaviour be tested without a terminal.
 *
 * Everything here is a READ MODEL. The panel renders what the ledger and the
 * working tree already recorded; it never writes back.
 */

/** A file the runtime (or the operator) changed. */
export interface PanelFileEntry {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** Lines added/removed, when git could count them. */
  added?: number;
  removed?: number;
  /** Git reported `-` for both counts: a binary file, not an empty change. */
  binary?: boolean;
}

/** A review finding, attributed to the role and model that produced it. */
export interface PanelFinding {
  id: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  claim: string;
  /** Reviewing role, when the recording event named one. */
  role?: string;
  /** Model that produced the review, when known. */
  model?: string;
  candidateId?: string;
  status: string;
}

/** Token and cost spend for one model. */
export interface PanelSpend {
  model: string;
  input: number;
  output: number;
  cost: number;
}

/** What an engineering run is doing right now. */
export interface PanelRunView {
  workItemId: string;
  goal: string;
  phase: string;
  risk: string;
  candidateId?: string;
  files: PanelFileEntry[];
  findings: PanelFinding[];
  spend: PanelSpend[];
}

/** What the repository looks like when no run is active. */
export interface PanelWorkspaceView {
  branch?: string;
  files: PanelFileEntry[];
  contextTokens?: number;
  contextPercent?: number;
  /**
   * Recent history, newest first.
   *
   * Carried so the panel has something to say on a clean tree. An always-on
   * panel that renders two lines and a "(0)" is not worth the columns it
   * occupies, and a clean repository is the common case at the start of a
   * session — precisely when the operator is deciding whether the panel earns
   * its place.
   */
  recentCommits?: Array<{ sha: string; subject: string; relative: string }>;
}

/**
 * A feeder failure, scoped to the section it broke.
 *
 * Errors are per-section and replaceable so one failing source degrades its
 * own part of the panel instead of the whole surface.
 */
export interface PanelSectionError {
  section: "run" | "workspace" | "memory";
  message: string;
}

/**
 * What this session put into memory. Every counter already exists on the
 * Blackhole manager state, so this is a read model like the rest of the panel.
 *
 * `enabled` is load-bearing: Blackhole is off by default, and a disabled
 * adapter must read as "off", never as zeros that look like a failure.
 */
export interface PanelMemoryView {
  enabled: boolean;
  entries: number;
  promotionCandidates: number;
  promoted: number;
  compactions: number;
  workers: { observer: number; reflector: number; dropper: number };
}

/**
 * The generated session narrative.
 *
 * `generated` is always true and is rendered as a label: this is the panel's
 * only model-authored content, and it must never be mistaken for a record.
 * `updatedAt` is shown rather than assumed — a narrative whose last update
 * failed stays put, and says when it was last actually current.
 */
export interface PanelNarrativeView {
  text: string;
  updatedAt: number;
  generated: true;
}

export interface PanelStateShape {
  run?: PanelRunView;
  narrative?: PanelNarrativeView;
  workspace?: PanelWorkspaceView;
  memory?: PanelMemoryView;
  errors: PanelSectionError[];
  updatedAt: number;
}

export type PanelListener = (state: Readonly<PanelStateShape>) => void;

/**
 * Lightweight observable state. Notifies subscribers on a real change only —
 * a patch that changes nothing publishes nothing, so a feeder polling on a
 * timer cannot cause a render storm.
 */
export class PanelState {
  private state: PanelStateShape;
  private readonly listeners = new Set<PanelListener>();
  private disposed = false;

  constructor(init?: Partial<PanelStateShape>) {
    this.state = {
      errors: [],
      updatedAt: 0,
      ...init,
    };
  }

  get snapshot(): Readonly<PanelStateShape> {
    return this.state;
  }

  /** Merge a partial patch and notify subscribers. No-op when nothing changed. */
  set(patch: Partial<PanelStateShape>): void {
    if (this.disposed) return;
    this.commit({ ...this.state, ...patch });
  }

  /** Record (or replace) the error for one section. */
  noteError(section: PanelSectionError["section"], message: string): void {
    if (this.disposed) return;
    const errors = [...this.state.errors.filter((e) => e.section !== section), { section, message }];
    this.commit({ ...this.state, errors });
  }

  /** Clear one section's error, if it has one. */
  clearError(section: PanelSectionError["section"]): void {
    if (this.disposed) return;
    if (!this.state.errors.some((e) => e.section === section)) return;
    this.commit({ ...this.state, errors: this.state.errors.filter((e) => e.section !== section) });
  }

  subscribe(listener: PanelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private commit(next: PanelStateShape): void {
    if (deepEqual(this.state, next)) return;
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // A misbehaving subscriber must never break the panel.
      }
    }
  }
}

function deepEqual(a: PanelStateShape, b: PanelStateShape): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
