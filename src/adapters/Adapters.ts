/**
 * Optional external adapters (backlog B-103 AutoSpec, B-104 InferWeave).
 *
 * Project constraint (AGENTS.md): core MUST NOT require AutoSpec, InferWeave,
 * a distributed cluster, multiple models, or GitHub. These adapters are
 * OPTIONAL seams: they are never invoked by core, never imported by core, and
 * default to `null`. An operator who installs one of these external systems may
 * plug it in to feed the runtime with planning/architecture artifacts or to
 * offload cross-session reasoning — but the runtime is fully standalone without
 * any of them.
 */
export interface AutoSpecAdapter {
  readonly name: "autospec";
  /** Produce a design spec for a goal (returns null if the system is absent). */
  designSpec(goal: string): Promise<string | null>;
  /** Split a spec into linked implementation issues. */
  splitSpec(specPath: string): Promise<Array<{ title: string; body: string }>>;
}

export interface InferWeaveAdapter {
  readonly name: "inferweave";
  /** Retrieve a relevant knowledge slice for a goal (null if absent). */
  retrieve(goal: string): Promise<string | null>;
  /** Record a learned invariant/hypothesis. */
  record(hypothesis: string, evidenceRef: string): Promise<void>;
}

/** Registry of optional adapters. Empty by default — core is standalone. */
export class AdapterRegistry {
  private readonly autospec: AutoSpecAdapter | null;
  private readonly inferweave: InferWeaveAdapter | null;

  constructor(opts: { autospec?: AutoSpecAdapter | null; inferweave?: InferWeaveAdapter | null } = {}) {
    this.autospec = opts.autospec ?? null;
    this.inferweave = opts.inferweave ?? null;
  }

  get autospecAdapter(): AutoSpecAdapter | null {
    return this.autospec;
  }

  get inferweaveAdapter(): InferWeaveAdapter | null {
    return this.inferweave;
  }

  /** True when any optional adapter is installed. */
  get hasAdapters(): boolean {
    return this.autospec !== null || this.inferweave !== null;
  }
}
