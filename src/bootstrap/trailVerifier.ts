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
import { sep } from "node:path";

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

/**
 * Generation directories, oldest first; the newest generation present for a task is its canonical record. `""` is the
 * protocol path (`<taskId>/<taskId>.handoff.json`), which `.gitignore` deliberately keeps untracked - a trail's
 * committed records live in the generation directories, so this list, not the protocol path, is where a finished trail
 * is actually found. A backfill ranks below every generation the run wrote itself: it is a reconstruction produced
 * afterwards and must never silently outrank a record the run stamped at the time.
 */
export const GENERATION_ORDER: readonly string[] = ["", "out-backfill", "out", "out2", "out-corrected", "out-final"];

/** The rank of a generation directory, or null when the reader does not know it. An unknown generation is reported, never guessed at. */
export function generationRank(generation: string): number | null {
  const rank = GENERATION_ORDER.indexOf(generation);
  return rank < 0 ? null : rank;
}

/** Generation directories that hold records but are not read. Skipping one silently would hide a record from the audit. */
export function unreadGenerations(dirNames: readonly string[]): string[] {
  return [...new Set(dirNames)].filter((name) => name.startsWith("out") && generationRank(name) === null).sort();
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
/** A process as the audit sees it: its command line, and the directory it was started in when that could be read. */
export interface LiveProcess {
  readonly pid: number;
  readonly command: string;
  /** Resolved working directory, or null when the platform would not say. An unreadable cwd is never attributed. */
  readonly cwd: string | null;
}

export interface LiveRunnerMatch {
  /** Command lines of processes still alive that are attributable to the audited checkout. */
  readonly attributed: string[];
  /** Processes that quoted a recorded command but belong elsewhere (another checkout, or an unreadable cwd). */
  readonly unattributed: number;
}

/** Characters that may follow a command inside a command line: whitespace, a shell operator, or end of line. */
const COMMAND_END = new Set(["", " ", "\t", "\n", "\r", ";", "&", "|", ">", "<", ")", "`"]);

/**
 * Whether `command` appears in `line` AS a command being run - delimited by shell syntax - rather than merely being
 * quoted inside another process's argument. A code-review prompt that says "You MAY run `npm test`" mentions the
 * command without running it, and attributing that to the audited run makes the gate fail for a reason that has
 * nothing to do with the trail.
 */
export function mentionsCommand(line: string, command: string): boolean {
  if (command.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = line.indexOf(command, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (line[at - 1] as string);
    const after = (line[at + command.length] ?? "") as string;
    if ((before === "" || before === " " || before === "\t" || ";&|(".includes(before)) && COMMAND_END.has(after)) return true;
    from = at + 1;
  }
}

/**
 * Which live processes belong to the audited run. Two things must hold, because either one alone has produced false
 * positives on real trails: the process must RUN a command the trail recorded (not merely mention it), and it must
 * have been started inside the audited checkout (its working directory is the root or below it). Processes that quote
 * a recorded command from elsewhere are counted as `unattributed` so the audit can say so instead of silently
 * ignoring them. An empty `attributed` list is not proof that nothing ever ran.
 */
export function matchLiveRunners(processes: readonly LiveProcess[], recordedCommands: readonly string[], root: string): LiveRunnerMatch {
  const recorded = recordedCommands.filter((command) => command.trim().length > 0);
  const boundary = root.endsWith(sep) ? root : root + sep;
  const attributed = new Set<string>();
  const elsewhere = new Set<string>();
  for (const process of processes) {
    const line = process.command.trim();
    if (line.length === 0 || line.includes("verify-handoff-trail")) continue;
    if (!recorded.some((command) => mentionsCommand(line, command))) continue;
    const inside = process.cwd !== null && (process.cwd === root || process.cwd.startsWith(boundary));
    (inside ? attributed : elsewhere).add(line);
  }
  return { attributed: [...attributed].sort(), unattributed: elsewhere.size };
}
