/**
 * Verify-before-revoke handoff ordering (spec section 4).
 *
 * The only legal order for an explicit handoff is
 *
 *   checkpoint verified -> source lease/process fenced -> successor acknowledged
 *
 * `verifyHandoffCheckpoint` is the verification step; `MissionStore.verifyHandoff`,
 * `fenceHandoffSource` and `acknowledgeHandoff` persist each step and refuse to run
 * out of order; `executeHandoff` drives all three and is idempotent, so a crash between
 * any two steps is recovered by calling it again on the reopened store. A checkpoint that
 * fails verification leaves the record un-advanced and the source untouched.
 *
 * Reuses `handoffResume.decideHandoffResume` (for records already past acknowledgement) and
 * `handoffRecovery.decideHandoffFallback` (what to do after a rejection). `reconcileSideEffects`
 * is intentionally not used: nothing in the runtime observes external side effects
 * (push/PR/comment) to feed it, so wiring it would only pass invented observations.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { GitRepo } from "../git/GitRepo.ts";
import type { HandoffEndpoint, HandoffRecord } from "../runtime/host/handoffKinds.ts";
import { type HandoffFallback, decideHandoffFallback } from "../runtime/host/handoffRecovery.ts";
import { type HandoffResumeDecision, decideHandoffResume } from "../runtime/host/handoffResume.ts";
import type { MissionStore } from "./missionStore.ts";
import type { MissionLease, TaskCheckpoint } from "./types.ts";

/** Everything verification needs from the outside world; all of it injectable for tests. */
export interface HandoffVerifyDeps {
  /** Content hash of an artifact as `sha256:<hex>`; null when it cannot be read. */
  hashArtifact(ref: string): Promise<string | null>;
  /** true/false when the repository can answer; null when it cannot be resolved (then the check is skipped). */
  commitExists(worktree: string, sha: string): Promise<boolean | null>;
  /** sha256 hex of a file under the worktree; null when it cannot be read. Optional: untracked hashes are checked only when given. */
  hashFile?(worktree: string, path: string): Promise<string | null>;
  /**
   * Accept a checkpoint whose commit or untracked files could not be checked (worktree gone, repo unresolvable,
   * no hasher). Default false: an unverifiable checkpoint is a failed one. Set only for an explicit operator override.
   */
  allowUnverifiable?: boolean;
}

export type HandoffVerification = { ok: true; skipped: string[] } | { ok: false; errors: string[] };

const SHA_PREFIX = /^[0-9a-f]{7,64}$/;
const ARTIFACT_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * Verify a checkpoint against the handoff record that names it. Collects every problem.
 * `skipped` lists checks that could not be run (e.g. worktree gone); a skipped check never
 * counts as a pass in the message but also never invents a failure.
 */
export async function verifyHandoffCheckpoint(
  record: HandoffRecord,
  checkpoint: TaskCheckpoint,
  deps: HandoffVerifyDeps,
): Promise<HandoffVerification> {
  const errors: string[] = [];
  const skipped: string[] = [];

  if (!record.checkpointSha || !SHA_PREFIX.test(record.checkpointSha)) {
    errors.push("handoff record names no checkpoint sha");
  }
  if (checkpoint.missionId !== record.missionId) errors.push("checkpoint belongs to a different mission");
  if (!checkpoint.sessionId || checkpoint.sessionId !== record.predecessor.sessionId) {
    errors.push("checkpoint was not written by the predecessor session");
  }
  if (!checkpoint.baseSha) errors.push("checkpoint has no base sha");
  if (!checkpoint.candidateSha) {
    errors.push("checkpoint has no candidate sha");
  } else if (record.checkpointSha && !checkpoint.candidateSha.startsWith(record.checkpointSha)) {
    errors.push("record checkpoint sha does not match the checkpoint's candidate sha");
  }

  // Required handoff fields. nextAction may legitimately be null (never invented); the rest must exist.
  const h = checkpoint.handoff;
  if (!h) {
    errors.push("checkpoint carries no handoff context");
  } else {
    for (const field of ["decisions", "unresolvedIssues", "tests", "memoryRefs", "untracked"] as const) {
      if (!Array.isArray(h[field])) errors.push(`handoff context ${field} is missing`);
    }
    if (h.nextAction !== null && typeof h.nextAction !== "string") errors.push("handoff context nextAction is missing");
  }

  if (checkpoint.artifactRefs.length !== checkpoint.artifactHashes.length) {
    errors.push("artifact refs and hashes length mismatch");
  } else {
    for (const [i, ref] of checkpoint.artifactRefs.entries()) {
      const expected = checkpoint.artifactHashes[i] as string;
      if (!ARTIFACT_HASH.test(expected)) {
        errors.push(`artifact ${ref} has a malformed hash`);
        continue;
      }
      const actual = await deps.hashArtifact(ref).catch(() => null);
      if (actual === null) errors.push(`artifact ${ref} cannot be read`);
      else if (actual !== expected) errors.push(`artifact ${ref} hash mismatch`);
    }
  }

  if (checkpoint.candidateSha) {
    if (!checkpoint.worktree) {
      skipped.push("commit existence: checkpoint names no worktree");
      if (!deps.allowUnverifiable) errors.push("candidate commit cannot be verified: checkpoint names no worktree");
    } else {
      const exists = await deps.commitExists(checkpoint.worktree, checkpoint.candidateSha).catch(() => null);
      if (exists === false)
        errors.push(`candidate commit ${checkpoint.candidateSha} does not exist in the worktree repo`);
      else if (exists === null) {
        skipped.push("commit existence: repository not resolvable");
        if (!deps.allowUnverifiable) errors.push("candidate commit cannot be verified: repository not resolvable");
      }
    }
  }

  if (h && Array.isArray(h.untracked) && h.untracked.length > 0) {
    if (!deps.hashFile || !checkpoint.worktree) {
      skipped.push("untracked file hashes: no file hasher or worktree");
      if (!deps.allowUnverifiable) errors.push("untracked file hashes cannot be verified: no file hasher or worktree");
    } else {
      for (const file of h.untracked) {
        const actual = await deps.hashFile(checkpoint.worktree, file.path).catch(() => null);
        if (actual === null) errors.push(`untracked file ${file.path} cannot be read`);
        else if (actual !== file.sha256) errors.push(`untracked file ${file.path} hash mismatch`);
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, skipped };
}

/** Production deps: artifact content via the ArtifactStore, commit existence via the worktree's own repo. */
export function createHandoffVerifyDeps(artifacts?: {
  readContentByUri(uri: string): Promise<string | undefined>;
}): HandoffVerifyDeps {
  return {
    async hashArtifact(ref) {
      if (!artifacts) return null;
      const content = await artifacts.readContentByUri(ref);
      return content === undefined ? null : `sha256:${createHash("sha256").update(content).digest("hex")}`;
    },
    async commitExists(worktree, sha) {
      try {
        const git = await GitRepo.open(worktree);
        if (!git) return null;
        return (await git.resolveCommit(sha)) !== null;
      } catch {
        return null;
      }
    },
    async hashFile(worktree, path) {
      try {
        const root = await realpath(worktree);
        const full = resolve(root, path);
        if (full !== root && !full.startsWith(`${root}${sep}`)) return null; // path escape
        if (!(await lstat(full)).isFile()) return null; // symlinks and directories are not hashed
        return createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
      } catch {
        return null;
      }
    },
  };
}

/**
 * Fence the mission lease named by `identity`. Idempotent for crash recovery: a lease that is already gone is
 * treated as fenced; a lease held at a different epoch is not ours to fence and throws.
 */
export function fenceMissionLease(
  store: Pick<MissionStore, "getMissionLease">,
  ownership: { fence(identity: MissionLease): Promise<void> },
  identity: MissionLease,
): () => Promise<void> {
  return async () => {
    const current = store.getMissionLease(identity.missionId);
    if (!current) return;
    if (current.generation !== identity.generation || current.fencingToken !== identity.fencingToken) {
      throw new Error(`mission lease ${identity.missionId} is held at a different epoch; refusing to fence it`);
    }
    await ownership.fence(identity);
  };
}

export type HandoffOutcome =
  | { status: "acknowledged"; record: HandoffRecord }
  | {
      status: "already_acknowledged";
      record: HandoffRecord;
      resume: { decision: HandoffResumeDecision; reasons: string[] };
    }
  | {
      status: "rejected";
      record: HandoffRecord;
      errors: string[];
      fallback: { fallback: HandoffFallback; reason: string };
    }
  | { status: "fence_failed"; record: HandoffRecord; error: string };

export interface ExecuteHandoffInput {
  handoffId: string;
  checkpoint: TaskCheckpoint;
  successor: HandoffEndpoint;
  deps: HandoffVerifyDeps;
  /** Revoke the source: lease fence, process quarantine. Must be idempotent. */
  fenceSource: () => Promise<void>;
  /** Used only to judge resumability of an already acknowledged record. */
  currentGeneration?: number;
  nowMs?: number;
  maxAgeMs?: number;
}

/** Drive verify -> fence -> acknowledge. Safe to call again after a crash at any step. */
export async function executeHandoff(store: MissionStore, input: ExecuteHandoffInput): Promise<HandoffOutcome> {
  const existing = store.getHandoffRecord(input.handoffId);
  if (!existing) throw new Error(`unknown handoff record ${input.handoffId}`);

  if (existing.state === "acknowledged" || existing.state === "committed") {
    if (existing.successor?.sessionId !== input.successor.sessionId) {
      throw new Error(`handoff ${input.handoffId} was already acknowledged by a different successor`);
    }
    const resume = decideHandoffResume({
      record: existing,
      currentLease: { generation: input.currentGeneration ?? input.successor.generation },
      observedCheckpointSha: input.checkpoint.candidateSha,
      expectedSourceSha: null,
      observedSourceSha: null,
      sideEffects: [],
      nowMs: input.nowMs ?? Date.now(),
      maxAgeMs: input.maxAgeMs ?? Number.POSITIVE_INFINITY,
    });
    return { status: "already_acknowledged", record: existing, resume };
  }
  if (existing.state === "aborted") throw new Error(`handoff ${input.handoffId} is aborted`);

  // Re-verify on a restart before the source was fenced (the evidence may have changed). Once the source is fenced
  // the stamp is the evidence: rejecting now would leave a revoked source and an unacknowledged record.
  const verdict = existing.sourceFencedAt
    ? ({ ok: true, skipped: [] } as const)
    : await store.verifyHandoff(input.handoffId, input.checkpoint, input.deps);
  if (!verdict.ok) {
    const fallback = decideHandoffFallback({
      resumeDecision: "refuse",
      resumeReasons: verdict.errors,
      contextUtilization: null,
    });
    return {
      status: "rejected",
      record: store.getHandoffRecord(input.handoffId) as HandoffRecord,
      errors: verdict.errors,
      fallback,
    };
  }
  try {
    await store.fenceHandoffSource(input.handoffId, input.fenceSource);
  } catch (error) {
    return {
      status: "fence_failed",
      record: store.getHandoffRecord(input.handoffId) as HandoffRecord,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const record = store.acknowledgeHandoff(input.handoffId, input.successor);
  return { status: "acknowledged", record };
}

/**
 * Fence the source's logical writer: its execution stops being authoritative (it can no longer publish checkpoints,
 * artifacts or candidates), then `terminateProcesses` stops what it already started. Idempotent: an execution that
 * is no longer RUNNING is already fenced and only the process step runs again.
 */
export function fenceExecutionWriter(
  store: Pick<MissionStore, "getExecution" | "rejectLateExecution">,
  executionId: string,
  terminateProcesses?: () => Promise<unknown>,
): () => Promise<void> {
  return async () => {
    if (store.getExecution(executionId)?.status === "RUNNING") {
      store.rejectLateExecution(executionId, "handoff source fenced");
    }
    await terminateProcesses?.();
  };
}

/** Run the fences in order; the first failure stops the chain so the caller can retry from the failed one. */
export function composeFences(...fences: Array<() => Promise<void>>): () => Promise<void> {
  return async () => {
    for (const fence of fences) await fence();
  };
}
