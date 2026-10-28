/**
 * One arbiter for Pi's status surfaces.
 *
 * The foreground spinner and the mission strip both want the working line, and
 * before this they each wrote `setWorkingMessage` directly, guarding the other
 * out with a private boolean (`agentActive`). That shape does not scale past two
 * producers: a third (a recovery notice, a gateway wait, a quota warning) has to
 * know every other producer's flag, and every pair needs a rule about who yields
 * to whom. Yields were written per-pair, so the rules disagreed and the last
 * writer won.
 *
 * Producers here claim a surface with a priority and an optional expiry. The bus
 * resolves the winner per surface, writes it, and hands the surface to the next
 * claimant when the winner releases — no producer knows any other. A claim that
 * expires is gone; nothing can hold a surface after its reason has ended.
 *
 * The bus is the only thing that touches the sink, so writes are deduplicated
 * once and a torn-down terminal is a no-op sink in exactly one place.
 */

/** Pi status surfaces a producer may claim. `widget` and `title` are keyed. */
export type SurfaceKind = "working" | "widget" | "title";

export interface SurfaceClaim {
  /** The working line / title. `undefined` releases the content. */
  text?: string;
  /** Widget lines. `undefined` releases the content. */
  lines?: string[];
  /** Higher wins. Equal priorities: the most recent write wins. */
  priority?: number;
  /** Epoch ms after which the claim no longer counts. */
  expiresAt?: number;
}

export interface SurfaceProducer {
  readonly kind: SurfaceKind;
  readonly id: string;
  publish(claim: SurfaceClaim): void;
  release(): void;
}

/** The subset of the Pi UI API the bus writes to. Every method is optional. */
export interface SurfaceSink {
  setWorkingMessage?(text?: string): void;
  setWidget?(key: string, lines: string[] | undefined): void;
  setTitle?(title: string | undefined): void;
  notify?(text: string, level: "info" | "warning"): void;
}

interface Entry {
  producer: string;
  kind: SurfaceKind;
  key: string;
  claim: SurfaceClaim;
  /** Write order tiebreak: a later write beats an equal-priority earlier one. */
  seq: number;
}

function surfaceKey(kind: SurfaceKind, key: string): string {
  return kind === "working" ? "working" : `${kind}:${key}`;
}

export class StatusSurfaceBus {
  private readonly sink: SurfaceSink;
  private readonly now: () => number;
  /** Live claims per surface, in producer-registration order. */
  private readonly claims = new Map<string, Entry[]>();
  /** What the sink last received per surface, so unchanged content is not rewritten. */
  private readonly written = new Map<string, string>();
  private readonly producers = new Map<string, SurfaceProducer>();
  private readonly registrations = new Map<string, { kind: SurfaceKind; key: string }>();
  /** Last notification key per producer, so one change notifies once. */
  private readonly notified = new Map<string, string>();
  private seq = 0;
  private disposed = false;

  constructor(sink: SurfaceSink, now: () => number = Date.now) {
    this.sink = sink;
    this.now = now;
  }

  /**
   * A producer for one surface. `key` names the widget (or is ignored for the
   * working line and title). Re-registering the same id reuses the producer.
   */
  producer(kind: SurfaceKind, id: string, options: { key?: string } = {}): SurfaceProducer {
    const existing = this.producers.get(id);
    if (existing) return existing;
    const key = options.key ?? (kind === "widget" ? id : "");
    const registration = { kind, key };
    const producer: SurfaceProducer = {
      kind,
      id,
      publish: (claim: SurfaceClaim): void => this.write(id, kind, key, claim),
      release: (): void => this.drop(id, kind, key),
    };
    this.producers.set(id, producer);
    this.registrations.set(id, registration);
    return producer;
  }

  /** Every surface the bus currently owns, for tests and diagnostics. */
  resolved(): Array<{ surface: string; producer: string; text?: string; lines?: string[] }> {
    const out: Array<{ surface: string; producer: string; text?: string; lines?: string[] }> = [];
    for (const [surface, entries] of this.claims) {
      const winner = this.pick(surface, entries);
      if (!winner) continue;
      out.push({
        surface,
        producer: winner.producer,
        ...(winner.claim.text !== undefined ? { text: winner.claim.text } : {}),
        ...(winner.claim.lines !== undefined ? { lines: winner.claim.lines } : {}),
      });
    }
    return out;
  }

  /** Drop expired claims and re-resolve. Cheap; safe to call on any tick. */
  prune(): void {
    let changed = false;
    for (const [surface, entries] of this.claims) {
      const live = entries.filter((entry) => entry.claim.expiresAt === undefined || entry.claim.expiresAt > this.now());
      if (live.length !== entries.length) {
        changed = true;
        if (live.length > 0) this.claims.set(surface, live);
        else this.claims.delete(surface);
      }
    }
    if (changed) this.refresh();
  }

  /**
   * Record what a producer last saw without notifying, so the next change
   * notifies even when nothing in between was worth interrupting for. A
   * mission that goes needs-you → running → needs-you changed twice.
   */
  observe(id: string, key: string): boolean {
    const changed = this.notified.get(id) !== key;
    this.notified.set(id, key);
    return changed;
  }

  /**
   * One notification per change. `key` is what changed (a state, a reason); the
   * same key never notifies twice for one producer, so a mission cannot spam the
   * terminal by ticking.
   */
  notify(id: string, key: string, text: string, level: "info" | "warning" = "info"): void {
    if (this.disposed) return;
    if (!this.observe(id, key)) return;
    this.guard(() => this.sink.notify?.(text, level));
  }

  /** Forget the notification history for a producer that is gone. */
  forget(id: string): void {
    this.notified.delete(id);
    const registration = this.registrations.get(id);
    this.producers.delete(id);
    this.registrations.delete(id);
    if (!registration) return;
    const surface = surfaceKey(registration.kind, registration.key);
    this.drop(id, registration.kind, registration.key);
    this.written.delete(`${surface}|${id}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const surface of [...this.claims.keys()]) {
      this.claims.delete(surface);
      this.writeSurface(surface, undefined);
    }
    this.producers.clear();
    this.registrations.clear();
    this.notified.clear();
  }

  private write(id: string, kind: SurfaceKind, key: string, claim: SurfaceClaim): void {
    if (this.disposed) return;
    const surface = surfaceKey(kind, key);
    const entries = this.claims.get(surface) ?? [];
    const seq = ++this.seq;
    const entry: Entry = { producer: id, kind, key, claim, seq };
    const next = entries.filter((candidate) => candidate.producer !== id);
    next.push(entry);
    // Registration order keeps resolution stable when priorities and writes tie.
    const ordered = [...next].sort((a, b) => entries.indexOf(a) - entries.indexOf(b) || a.seq - b.seq);
    this.claims.set(surface, ordered);
    // Always re-resolve: a producer replacing its own winning claim with nothing
    // must hand the surface over, not leave its last text on screen.
    this.writeSurface(surface, this.pick(surface, ordered));
  }

  private drop(id: string, kind: SurfaceKind, key: string): void {
    const surface = surfaceKey(kind, key);
    const entries = this.claims.get(surface);
    if (!entries) return;
    const remaining = entries.filter((entry) => entry.producer !== id);
    if (remaining.length === entries.length) return;
    if (remaining.length > 0) this.claims.set(surface, remaining);
    else this.claims.delete(surface);
    // The surface does not go blank; the next claimant takes it.
    this.writeSurface(surface, this.pick(surface, remaining));
  }

  /** Highest priority wins; equal priority, the most recent write. */
  private pick(surface: string, entries: readonly Entry[]): Entry | undefined {
    const now = this.now();
    let best: Entry | undefined;
    for (const entry of entries) {
      if (entry.claim.expiresAt !== undefined && entry.claim.expiresAt <= now) continue;
      if (entry.claim.text === undefined && entry.claim.lines === undefined) continue;
      const priority = entry.claim.priority ?? 0;
      const bestPriority = best?.claim.priority ?? 0;
      if (!best || priority > bestPriority || (priority === bestPriority && entry.seq > best.seq)) best = entry;
    }
    return best;
  }

  /** Re-resolve every surface the bus owns (used after a prune). */
  private refresh(): void {
    for (const [surface, entries] of this.claims) this.writeSurface(surface, this.pick(surface, entries));
  }

  private writeSurface(surface: string, winner: Entry | undefined): void {
    const fingerprint = winner ? `${winner.claim.text ?? ""}\u0000${winner.claim.lines?.join("\n") ?? ""}` : undefined;
    if (this.written.get(surface) === fingerprint) return;
    if (fingerprint === undefined) this.written.delete(surface);
    else this.written.set(surface, fingerprint);

    if (surface === "working") {
      this.guard(() => this.sink.setWorkingMessage?.(winner?.claim.text));
      return;
    }
    const [kind, ...rest] = surface.split(":");
    const key = rest.join(":");
    if (kind === "title") {
      this.guard(() => this.sink.setTitle?.(winner?.claim.text));
      return;
    }
    this.guard(() => this.sink.setWidget?.(key, winner?.claim.lines));
  }

  /** A status surface is observational; a torn-down UI must never fail a mission. */
  private guard(action: () => void): void {
    try {
      action();
    } catch {
      // The surface is gone; the work keeps running.
    }
  }
}
