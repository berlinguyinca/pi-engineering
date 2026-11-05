/**
 * V07: verify a finished handoff trail from the outside. Where `resultGate` gates ONE task at write time, this
 * walks a WHOLE trail after the fact and is deliberately run by something other than the process that wrote the
 * records — the protocol itself says a stamped `operatorApproval` and a `handoffHash` are an accidental-modification
 * detector, not authorization (02-HANDOFF-PROTOCOL.md:19), so self-attestation is what this checks, not trusts.
 *
 * Six things are checked, and each produces a named issue rather than a verdict-by-opinion:
 *   `hash-mismatch`         — the record no longer hashes to its stamp (canonicalization from `resultGate`).
 *   `schema-violation`      — the record no longer conforms to `templates/handoff.schema.json` (`handoffWriter`).
 *   `missing-record`        — a task the plan ordered has no record at all.
 *   `lineage-break`         — a parent's `nextBaseSha` is not the child's `baseSha`.
 *   `evidence-absent`       — a declared `evidence` entry or `commands[].outputArtifact` is not on disk.
 *   `evidence-uncommitted`  — it is on disk but no blob exists at the trail revision (working tree ≠ repository).
 *   `unplanned-record`      — a record whose taskId the plan never ordered (deviations are reported, not admitted).
 *   `live-runner`           — a process the run started is still alive, so "tests finished" is unproven.
 *
 * Pure and total: every filesystem and git observation is injected, nothing here reads, writes, spawns or throws.
 */
import { validateHandoffSchema } from "./handoffWriter.ts";
import { canonicalHash } from "./resultGate.ts";

export interface TrailRecord {
  readonly taskId: string;
  readonly record: Record<string, unknown>;
}
export type TrailIssueKind =
  | "duplicate-record"
  | "hash-mismatch"
  | "schema-violation"
  | "missing-record"
  | "lineage-break"
  | "next-pointer-mismatch"
  | "evidence-absent"
  | "evidence-uncommitted"
  | "unplanned-record"
  | "live-runner";
export interface TrailIssue {
  readonly kind: TrailIssueKind;
  readonly taskId: string | null;
  readonly detail: string;
}
export interface TrailVerdict {
  readonly ok: boolean;
  readonly records: number;
  readonly issues: readonly TrailIssue[];
}
export interface TrailInput {
  /** `templates/handoff.schema.json`, parsed. */
  readonly schema: unknown;
  /** Task ids in plan order — the lineage the plan promised, taken from the manifest, never from the records. */
  readonly order: readonly string[];
  readonly records: readonly TrailRecord[];
  /** Presence of a declared artifact in the evidence tree. Omit to skip on-disk checks. */
  readonly artifactExists?: (path: string) => boolean;
  /** Whether a blob exists for that path at the revision under audit. Omit to skip repository-presence checks. */
  readonly committed?: (path: string) => boolean;
  /** Descriptions (argv) of processes the run started that are still alive. Omit to skip the liveness gate. */
  readonly liveRunners?: readonly string[];
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
/** Every artifact a record points at: its `evidence` list plus every command's `outputArtifact`. */
export const declaredArtifacts = (record: Record<string, unknown>): string[] => {
  const outputs = (Array.isArray(record.commands) ? record.commands : [])
    .filter((command): command is Record<string, unknown> => command !== null && typeof command === "object" && !Array.isArray(command) && typeof (command as Record<string, unknown>).outputArtifact === "string")
    .map((command) => command.outputArtifact as string);
  return [...new Set([...strings(record.evidence), ...outputs])].sort();
};

/** Verify a whole trail. `ok` means zero issues of any kind; every issue names the task and the observation. */
export function verifyTrail(input: TrailInput): TrailVerdict {
  const issues: TrailIssue[] = [];
  const byTask = new Map<string, Record<string, unknown>>();
  for (const entry of input.records) {
    if (byTask.has(entry.taskId)) issues.push({ kind: "duplicate-record", taskId: entry.taskId, detail: `a second record exists for task ${entry.taskId}` });
    byTask.set(entry.taskId, entry.record);
    const stamped = entry.record.handoffHash;
    const recomputed = canonicalHash(entry.record);
    if (stamped !== recomputed) issues.push({ kind: "hash-mismatch", taskId: entry.taskId, detail: `stamped ${String(stamped)} != recomputed ${recomputed}` });
    for (const blocker of validateHandoffSchema(entry.record, input.schema)) issues.push({ kind: "schema-violation", taskId: entry.taskId, detail: blocker });
    for (const artifact of declaredArtifacts(entry.record)) {
      if (input.artifactExists !== undefined && !input.artifactExists(artifact)) issues.push({ kind: "evidence-absent", taskId: entry.taskId, detail: `declared artifact absent: ${artifact}` });
      if (input.committed !== undefined && !input.committed(artifact)) issues.push({ kind: "evidence-uncommitted", taskId: entry.taskId, detail: `declared artifact has no blob at the audited revision: ${artifact}` });
    }
  }
  const ordered = new Set(input.order);
  for (const taskId of input.order) if (!byTask.has(taskId)) issues.push({ kind: "missing-record", taskId, detail: `the plan ordered ${taskId} and no record exists` });
  for (const taskId of [...byTask.keys()].sort()) if (!ordered.has(taskId)) issues.push({ kind: "unplanned-record", taskId, detail: `${taskId} carries a record the plan never ordered` });
  for (let index = 1; index < input.order.length; index += 1) {
    const parent = byTask.get(input.order[index - 1] as string);
    const child = byTask.get(input.order[index] as string);
    if (parent === undefined || child === undefined) continue; // already reported as missing-record
    const promised = parent.nextBaseSha;
    const actual = child.baseSha;
    if (typeof promised === "string" && typeof actual === "string" && promised !== actual)
      issues.push({ kind: "lineage-break", taskId: input.order[index] as string, detail: `${input.order[index - 1]}.nextBaseSha ${promised} != ${input.order[index]}.baseSha ${actual}` });
  }
  for (let index = 0; index < input.order.length; index += 1) {
    const record = byTask.get(input.order[index] as string);
    if (record === undefined || !("nextTaskId" in record)) continue; // absence is already a missing-record issue
    const promised = index + 1 < input.order.length ? (input.order[index + 1] as string) : null;
    if (record.nextTaskId !== promised)
      issues.push({ kind: "next-pointer-mismatch", taskId: input.order[index] as string, detail: `record declares nextTaskId ${JSON.stringify(record.nextTaskId)} where the plan orders ${JSON.stringify(promised)}` });
  }
  for (const runner of input.liveRunners ?? []) issues.push({ kind: "live-runner", taskId: null, detail: `process started by the run is still alive: ${runner}` });
  return { ok: issues.length === 0, records: input.records.length, issues };
}

/** A record plus the generation that produced it; the newest generation for a task is the canonical one. */
export interface TrailRecordGeneration extends TrailRecord {
  readonly generation: number;
}
/** One record per task: the highest `generation` wins; a tie at the top keeps the entry seen first (a tie is not a choice we make). */
export function selectCanonical(records: readonly TrailRecordGeneration[]): TrailRecord[] {
  const best = new Map<string, TrailRecordGeneration>();
  for (const entry of records) {
    const incumbent = best.get(entry.taskId);
    if (incumbent === undefined || entry.generation > incumbent.generation) best.set(entry.taskId, entry);
  }
  return [...best.values()].map(({ taskId, record }) => ({ taskId, record }));
}
/**
 * Which live processes belong to the audited run: a process line counts when it contains a command the trail itself
 * recorded. The verifier's own invocation never counts. Empty means "nothing the run started is still running" - it
 * is not proof that nothing ever ran.
 */
export function matchLiveRunners(processLines: readonly string[], recordedCommands: readonly string[]): string[] {
  const unique = [...new Set(processLines.map((line) => line.trim()))].filter((line) => line.length > 0 && !line.includes("verify-handoff-trail")).filter((line) => recordedCommands.some((command) => command.length > 0 && line.includes(command)));
  return unique.sort();
}
