/**
 * EnvelopeStore — the emit-side pairing of a persisted sequence allocator and a
 * durable outbox. `stage()` stamps a draft with the next source_sequence and
 * persists the finished envelope; delivery (and retry) is the caller's job and
 * always replays the persisted envelope, so event_id / source_sequence never
 * change between attempts.
 *
 * Staging rules:
 *  - payloads are redacted (platform/redact) before they touch disk;
 *  - an oversized payload is dead-lettered at stage time and never sent;
 *  - an event_id that is already pending (or already completed) is NOT given a
 *    new sequence: the existing envelope is returned;
 *  - ids derived from content by an adapter get a per-occurrence nonce, so two
 *    legitimately identical events stay distinct (retries are unaffected: the
 *    persisted envelope keeps its nonce'd id).
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { redactDeep, redactSecrets } from "../../platform/redact.ts";
import { resolveStateRoot } from "../isolation/stateDir.ts";
import { type EnvelopeDraft, type EnvelopeV2, SOURCE_PATTERN, buildEnvelope } from "./envelope.ts";
import { EnvelopeOutbox, type OutboxStats } from "./outbox.ts";
import { SourceSequence } from "./sourceSequence.ts";

export interface EnvelopeStoreOptions {
  /** Sequence domain. Default: unique per emitter instance (see {@link defaultSource}). */
  source?: string;
  /** Directory for sequence + outbox files. Default `<state root>/control-plane`. */
  dir?: string;
  maxPending?: number;
  /** Per-event payload cap in bytes (default 256 KiB). */
  maxEventBytes?: number;
  /** Sequence numbers reserved per persisted write (default 1 = strictly contiguous, so a server-seen gap always means loss; larger values trade fsyncs for a burned-number gap per restart). */
  sequenceBlock?: number;
}

export type StageResult =
  | { status: "staged" | "pending"; envelope: EnvelopeV2 }
  | { status: "delivered" | "dead_lettered" };

/**
 * `pi-<host>-<instance>`: host is sanitized and truncated, the instance part is
 * a random id persisted in the state dir, so two machines or users never share
 * a (source, sequence) domain and a restart keeps the same source. Total length
 * <= 28, within the server's `[a-z][a-z0-9_-]{0,31}`.
 */
export function defaultSource(dir: string): string {
  const file = join(dir, "instance-id");
  let id = "";
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    id = readFileSync(file, "utf8").trim();
  } catch {
    // first run, or the state dir is unusable
  }
  if (!/^[0-9a-f]{8}$/.test(id)) {
    id = randomBytes(4).toString("hex");
    try {
      writeFileSync(file, `${id}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      // lost a creation race with another process: adopt its id. If the dir is
      // unusable the id stays process-local (emits will fail to persist anyway).
      try {
        const other = readFileSync(file, "utf8").trim();
        if (/^[0-9a-f]{8}$/.test(other)) id = other;
      } catch {
        // keep the process-local id
      }
    }
  }
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16)
      .replace(/-+$/g, "") || "host";
  return `pi-${host}-${id}`;
}

/**
 * Per-instance secret for derived event ids, persisted 0600 next to the instance id.
 * Without it a derived id is a pure function of public data (the source string is listed
 * by the ingest sources endpoint), so a third party could pre-register a victim's next
 * event_id. Unusable state dir: a process-local secret (ids stay stable within the process).
 */
export function loadIdSecret(dir: string): string {
  const file = join(dir, "id-secret");
  const valid = (v: string) => /^[0-9a-f]{64}$/.test(v);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existing = readFileSync(file, "utf8").trim();
    if (valid(existing)) return existing;
  } catch {
    // first run, or unreadable
  }
  const fresh = randomBytes(32).toString("hex");
  try {
    writeFileSync(file, `${fresh}\n`, { flag: "wx", mode: 0o600 });
    return fresh;
  } catch {
    try {
      const other = readFileSync(file, "utf8").trim();
      if (valid(other)) return other; // lost a creation race: adopt the winner
    } catch {
      // keep the process-local secret
    }
  }
  return fresh;
}

/**
 * Redact the payload as JSON text first (that catches `"password": "..."`
 * key-shaped secrets, which a per-string walk cannot see), falling back to the
 * per-string walk if the redacted text no longer parses.
 */
function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(payload))) as Record<string, unknown>;
  } catch {
    try {
      return redactDeep(payload);
    } catch {
      return payload;
    }
  }
}

export class EnvelopeStore {
  readonly source: string;
  readonly outbox: EnvelopeOutbox;
  readonly sequence: SourceSequence;
  private readonly maxEventBytes: number;
  private readonly idSecret: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: EnvelopeStoreOptions = {}) {
    const dir = opts.dir ?? join(resolveStateRoot(), "control-plane");
    this.source = opts.source ?? defaultSource(dir);
    if (!SOURCE_PATTERN.test(this.source)) throw new TypeError(`invalid source "${this.source}"`);
    this.maxEventBytes = opts.maxEventBytes ?? 256 * 1024;
    this.idSecret = loadIdSecret(dir);
    this.sequence = new SourceSequence({ dir, source: this.source, blockSize: opts.sequenceBlock ?? 1 });
    this.outbox = new EnvelopeOutbox({ file: join(dir, `outbox-${this.source}.jsonl`), maxPending: opts.maxPending });
  }

  /**
   * Deterministic, unguessable event id: HMAC-SHA256 keyed with the per-instance secret over
   * the parts. Same parts + same instance => same id (retry dedupe, stable across restart);
   * another instance, or anyone without the secret, cannot compute it.
   */
  deriveEventId(prefix: string, parts: readonly unknown[]): string {
    const mac = createHmac("sha256", this.idSecret)
      .update(JSON.stringify([prefix, ...parts]))
      .digest("hex");
    return `${prefix}_${mac.slice(0, 32)}`;
  }

  /** Counters for the health / diagnostic path. */
  stats(): OutboxStats & { sequenceFailures: number; source: string } {
    return { ...this.outbox.stats(), sequenceFailures: this.sequence.failures, source: this.source };
  }

  /**
   * Allocate a sequence and persist the envelope. Allocation and append happen
   * in one serialized step so outbox order == sequence order within a process.
   */
  stage(input: EnvelopeDraft): Promise<StageResult> {
    const run = this.tail.then(() => this.stageNow(input));
    this.tail = run.catch(() => {});
    return run;
  }

  private async stageNow(input: EnvelopeDraft): Promise<StageResult> {
    const payload = redactPayload(input.payload);
    const draft: EnvelopeDraft = { ...input, payload };
    if (draft.event_id && input.event_id_derived) {
      // Adapter ids are content hashes of public-ish data: re-key them with the secret, then add the nonce.
      const prefix = draft.event_id.split("_")[0] || "evt";
      draft.event_id = `${this.deriveEventId(prefix, [draft.event_id])}-${randomUUID().slice(0, 8)}`;
    }

    buildEnvelope(draft, { source: this.source, sourceSequence: 0 }); // validate BEFORE burning a sequence

    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > this.maxEventBytes) {
      await this.outbox.recordUndeliverable(
        {
          event_type: draft.event_type,
          entity_type: draft.entity_type,
          entity_id: draft.entity_id,
          occurred_at: draft.occurred_at,
          payload_bytes: bytes,
          payload_preview: JSON.stringify(payload).slice(0, 2048),
        },
        "oversized",
      );
      return { status: "dead_lettered" };
    }

    if (draft.event_id && !input.event_id_derived) {
      const known = await this.outbox.lookup(draft.event_id);
      if (known?.state === "pending") return { status: "pending", envelope: known.envelope };
      if (known) return { status: known.state === "delivered" ? "delivered" : "dead_lettered" };
    }

    const sourceSequence = await this.sequence.next();
    const envelope = buildEnvelope(draft, { source: this.source, sourceSequence });
    const stored = await this.outbox.append(envelope);
    return { status: stored === envelope ? "staged" : "pending", envelope: stored };
  }
}
