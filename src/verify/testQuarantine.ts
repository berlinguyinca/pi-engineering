import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExclusiveFileLock } from "../platform/eventstore/fileLock.ts";
import type { VerifyOutcome } from "./Verifier.ts";
import type { GroupProcess, ProgressKind, StallEvidence } from "./testWatchdog.ts";

/**
 * Test quarantine (autospec R-WATCH, issue #147).
 *
 * A test that stalls twice with the SAME signature is a hung test, not bad
 * luck: it is quarantined, the record is persisted in the runtime state dir,
 * and any verification outcome that depends on it reports `blocked`. A
 * quarantined test is never dropped from the pass count and never read as
 * green; only an operator releases it (deleting its record), which this module
 * deliberately does not offer.
 *
 * The signature is the test id, the kind of the last progress the watchdog saw
 * and the top command of the evidence tree, so a different hang (another place
 * in the tree, or after other progress) does not count towards the same
 * quarantine. Numbers are normalised so pids, ports and temp-dir suffixes
 * cannot make identical stalls look different.
 *
 * One JSON file per test id under `<stateDir>/quarantine/`, updated with
 * temp-file plus `rename` under one cross-process lock, so a crash leaves
 * either the old record or the new one.
 */

export const QUARANTINE_SCHEMA_VERSION = 1;

/** Identical stalls needed to quarantine a test (spec §5 R-WATCH). */
export const QUARANTINE_AFTER_STALLS = 2;

/** The watchdog's evidence plus the last progress kind it observed. */
export interface QuarantineEvidence extends StallEvidence {
  lastProgressKind: ProgressKind | null;
}

export interface QuarantineRecord {
  schemaVersion: number;
  testId: string;
  /** The signature that repeated. */
  signature: string;
  /** References (artifact ids or paths) to the evidence of the repeated stalls. */
  evidenceRefs: string[];
  firstSeen: string;
  quarantinedAt: string;
}

interface StallEntry {
  signature: string;
  at: string;
  evidenceRef: string;
}

interface StateFile {
  schemaVersion: number;
  testId: string;
  stalls: StallEntry[];
  quarantine?: QuarantineRecord;
}

/** A verification outcome that depends on a quarantined test. */
export type QuarantinedOutcome = VerifyOutcome & {
  status: "blocked";
  /** The quarantined test ids the outcome depends on. */
  quarantined: string[];
};

const LOCK_WAIT_MS = 30_000;

/** Command of the root of the evidence tree: the process whose parent is not in the group. */
function topCommand(processes: readonly GroupProcess[]): string {
  const pids = new Set(processes.map((p) => p.pid));
  const roots = processes.filter((p) => !pids.has(p.ppid)).sort((a, b) => a.pid - b.pid);
  return (roots[0] ?? processes[0])?.command ?? "";
}

/** Numbers are volatile (pids, ports, temp-dir suffixes); everything else is the shape of the hang. */
function normalizeCommand(command: string): string {
  return command.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** Test id + last progress kind + top command of the evidence tree, hashed. */
export function stallSignature(testId: string, evidence: QuarantineEvidence): string {
  return createHash("sha256")
    .update(
      JSON.stringify([testId, evidence.lastProgressKind ?? "none", normalizeCommand(topCommand(evidence.processes))]),
    )
    .digest("hex");
}

function fileFor(testId: string): string {
  return `q-${createHash("sha256").update(testId).digest("hex")}.json`;
}

function isStateFile(value: unknown, name: string): value is StateFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === QUARANTINE_SCHEMA_VERSION &&
    typeof v.testId === "string" &&
    fileFor(v.testId) === name &&
    Array.isArray(v.stalls) &&
    v.stalls.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as StallEntry).signature === "string" &&
        typeof (s as StallEntry).at === "string" &&
        typeof (s as StallEntry).evidenceRef === "string",
    )
  );
}

/** Test ids an outcome depends on: failing tests plus ids a stage lists under `summary.tests`/`summary.stalledTest`. */
function testIdsOf(outcome: VerifyOutcome): string[] {
  const ids = new Set<string>();
  for (const stage of outcome.stages) {
    for (const id of stage.failingTests ?? []) ids.add(id);
    const listed = stage.summary.tests;
    if (Array.isArray(listed)) for (const id of listed) if (typeof id === "string") ids.add(id);
    if (typeof stage.summary.stalledTest === "string") ids.add(stage.summary.stalledTest);
  }
  return [...ids];
}

export class TestQuarantine {
  private readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.dir = join(stateDir, "quarantine");
  }

  /**
   * Records a stall. Returns true once the test is quarantined: the second
   * identical signature quarantines it, and an already quarantined test stays so.
   */
  async recordStall(testId: string, evidence: QuarantineEvidence, evidenceRef: string): Promise<boolean> {
    if (testId.trim().length === 0) throw new Error("test id must be a non-empty string");
    const signature = stallSignature(testId, evidence);
    return this.locked(async () => {
      const state = (await this.read(testId)) ?? { schemaVersion: QUARANTINE_SCHEMA_VERSION, testId, stalls: [] };
      if (state.quarantine) return true;
      const now = new Date().toISOString();
      state.stalls.push({ signature, at: now, evidenceRef });
      const same = state.stalls.filter((s) => s.signature === signature);
      if (same.length >= QUARANTINE_AFTER_STALLS) {
        state.quarantine = {
          schemaVersion: QUARANTINE_SCHEMA_VERSION,
          testId,
          signature,
          evidenceRefs: same.map((s) => s.evidenceRef),
          firstSeen: same[0]!.at,
          quarantinedAt: now,
        };
      }
      await this.write(state);
      return state.quarantine !== undefined;
    });
  }

  async isQuarantined(testId: string): Promise<boolean> {
    return (await this.get(testId)) !== undefined;
  }

  /** The quarantine record, when the test is quarantined. */
  async get(testId: string): Promise<QuarantineRecord | undefined> {
    return this.locked(async () => (await this.read(testId))?.quarantine);
  }

  /**
   * An outcome that depends on a quarantined test is `blocked` and not passed,
   * whatever the stages reported. Any other outcome is returned unchanged.
   */
  async applyToOutcome(outcome: VerifyOutcome): Promise<VerifyOutcome | QuarantinedOutcome> {
    const quarantined: string[] = [];
    for (const id of testIdsOf(outcome)) if (await this.isQuarantined(id)) quarantined.push(id);
    if (quarantined.length === 0) return outcome;
    return {
      ...outcome,
      passed: false,
      status: "blocked",
      quarantined,
      failedStage: outcome.failedStage ?? "quarantine",
      warnings: [
        ...(outcome.warnings ?? []),
        `blocked: depends on quarantined test${quarantined.length === 1 ? "" : "s"}: ${quarantined.join(", ")}`,
      ],
    };
  }

  // --- storage -------------------------------------------------------------

  private async read(testId: string): Promise<StateFile | undefined> {
    const name = fileFor(testId);
    let text: string;
    try {
      text = await readFile(join(this.dir, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isStateFile(parsed, name) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(state: StateFile): Promise<void> {
    const name = fileFor(state.testId);
    const tmp = join(this.dir, `.${name}.tmp-${randomUUID()}`);
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(tmp, join(this.dir, name));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const deadline = Date.now() + LOCK_WAIT_MS;
      let lock: ExclusiveFileLock;
      for (;;) {
        try {
          lock = await ExclusiveFileLock.acquire(join(this.dir, "quarantine"));
          break;
        } catch (error) {
          if (!/is held|is claimed/.test(error instanceof Error ? error.message : "")) throw error;
          if (Date.now() >= deadline) throw new Error("timed out waiting for the quarantine lock");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      try {
        return await fn();
      } finally {
        lock.release();
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
