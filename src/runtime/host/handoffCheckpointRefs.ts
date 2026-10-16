/**
 * Immutable checkpoint reference set for handoff records (spec: handoff
 * checkpoints carry a full source SHA plus artifact refs with sha256 hashes so a
 * successor generation can prove exactly which checkpoint it resumes from).
 *
 * This module is pure: it only builds and attaches immutable checkpoint reference
 * sets — no I/O, no Date.now, no classes. The input is never mutated; returned
 * arrays and objects are always fresh.
 */

import type { HandoffRecord } from "./handoffKinds.ts";

/** A reference to a checkpoint artifact plus its immutable sha256 hash. */
export interface CheckpointArtifactRef {
  ref: string;
  sha256: string;
}

/** The immutable checkpoint reference set attached to a handoff record. */
export interface HandoffCheckpointRefs {
  checkpointSha: string;
  sourceSha: string;
  artifacts: readonly CheckpointArtifactRef[];
}

/** Inputs for building a checkpoint reference set. */
export interface CheckpointRefsInput {
  checkpointSha: string;
  sourceSha: string;
  artifactRefs: readonly string[];
  artifactHashes: readonly string[];
}

/** Result of building a checkpoint reference set: refs on success, errors on failure. */
export type CheckpointRefsResult = { ok: true; refs: HandoffCheckpointRefs } | { ok: false; errors: string[] };

/** A handoff checkpoint must be a full immutable commit sha (40 lowercase hex). */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

const ARTIFACT_SHA_PATTERN = /^[0-9a-f]{64}$/;

const ARTIFACT_PREFIX = "artifact://";

/**
 * Build a `HandoffCheckpointRefs` from raw inputs, collecting ALL errors in a
 * defined order. Never short-circuits except when the artifact ref/hash lengths
 * mismatch (which makes per-index artifact rules meaningless). The input is never
 * mutated; on success `refs.artifacts` is a fresh array of fresh objects in input
 * order.
 */
export function buildCheckpointRefs(input: CheckpointRefsInput): CheckpointRefsResult {
  const errors: string[] = [];

  if (!FULL_SHA_PATTERN.test(input.checkpointSha)) {
    errors.push("checkpointSha must be a 40-hex commit sha");
  }

  if (!FULL_SHA_PATTERN.test(input.sourceSha)) {
    errors.push("sourceSha must be a 40-hex commit sha");
  }

  if (input.artifactRefs.length !== input.artifactHashes.length) {
    errors.push("artifact refs and hashes length mismatch");
  } else {
    for (let i = 0; i < input.artifactRefs.length; i += 1) {
      // Lengths match and i is in range, so both index accesses are defined.
      const ref = input.artifactRefs[i] as string;
      const hash = input.artifactHashes[i] as string;
      if (!ref.startsWith(ARTIFACT_PREFIX) || ref === ARTIFACT_PREFIX) {
        errors.push(`artifact ref ${i} must start with artifact://`);
      }
      if (!ARTIFACT_SHA_PATTERN.test(hash)) {
        errors.push(`artifact hash ${i} must be 64-hex sha256`);
      }
    }

    const seen = new Set<string>();
    for (const ref of input.artifactRefs) {
      if (seen.has(ref)) {
        errors.push(`duplicate artifact ref ${ref}`);
      } else {
        seen.add(ref);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    refs: {
      checkpointSha: input.checkpointSha,
      sourceSha: input.sourceSha,
      artifacts: input.artifactRefs.map((ref, i) => ({
        ref,
        sha256: input.artifactHashes[i] as string,
      })),
    },
  };
}

/**
 * Attach an immutable checkpoint reference set to a handoff record. Returns a new
 * object; the input record is never mutated.
 */
export function attachCheckpointRefs(record: HandoffRecord, refs: HandoffCheckpointRefs): HandoffRecord {
  return { ...record, checkpointSha: refs.checkpointSha };
}
