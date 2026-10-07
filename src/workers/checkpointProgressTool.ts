import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface CheckpointProgressClaim {
  deliverable: string;
  candidateSha: string;
  evidencePaths: string[];
  artifactRefs: string[];
}

/** Stable tool name (broker and executor event filters depend on it). */
export const CHECKPOINT_PROGRESS_TOOL_NAME = "checkpoint_progress";

/**
 * Build the checkpoint_progress tool bound to a task's DECLARED deliverables.
 *
 * Feedback contract (defect B): the broker settles claims against the Git
 * snapshot at finalization, but the most common failure — claiming a
 * deliverable label that is not one of the declared strings — is detectable
 * IMMEDIATELY. Pre-feedback, that failure surfaced only as a 'major' store
 * finding after settlement, the worker's tool call said "Recorded N claim(s)
 * for broker validation", and the worker could never self-correct (observed
 * live: a repair task declared its objective string as the deliverable and
 * the worker claimed "repair"). The tool now rejects undeclared labels up
 * front and returns the exact declared list, while SHA/committed-path
 * validation remains at settlement (gate semantics unchanged).
 */
export function createCheckpointProgressTool(
  declaredDeliverables: readonly string[],
): ReturnType<typeof defineTool> {
  return defineTool({
    name: CHECKPOINT_PROGRESS_TOOL_NAME,
    label: "Checkpoint Progress",
    description:
      "Record completed declared deliverables after committing them. Claims are accepted only when candidate SHA and committed path evidence match the broker's Git snapshot.",
    promptSnippet: "Record durable candidate-bound progress after each coherent commit",
    promptGuidelines: [
      "After committing a coherent subset, run git rev-parse HEAD and call checkpoint_progress.",
      "Claim the deliverable using EXACTLY the declared string (no paraphrasing, shortening, or renaming).",
      "Include only declared deliverables and paths contained in that commit.",
    ],
    parameters: Type.Object({
      claims: Type.Array(
        Type.Object({
          deliverable: Type.String({ minLength: 1, maxLength: 160 }),
          candidate_sha: Type.String({ minLength: 1, maxLength: 160 }),
          evidence_paths: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 64 }),
          artifact_refs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 32 })),
        }),
        { minItems: 1, maxItems: 32 },
      ),
    }),
    async execute(_toolCallId, params) {
      const declared = [...declaredDeliverables];
      const accepted: CheckpointProgressClaim[] = [];
      const rejected: Array<{ deliverable: string; reason: string }> = [];
      for (const claim of params.claims) {
        if (!declared.includes(claim.deliverable)) {
          rejected.push({
            deliverable: claim.deliverable,
            reason: "not a declared deliverable",
          });
          continue;
        }
        accepted.push({
          deliverable: claim.deliverable,
          candidateSha: claim.candidate_sha,
          evidencePaths: [...claim.evidence_paths],
          artifactRefs: [...(claim.artifact_refs ?? [])],
        });
      }
      const lines: string[] = [];
      if (accepted.length > 0) {
        lines.push(`Recorded ${accepted.length} checkpoint progress claim(s) for broker validation.`);
      }
      if (rejected.length > 0) {
        lines.push(
          `REJECTED ${rejected.length} claim(s) — ${rejected
            .map((r) => `deliverable "${r.deliverable}" is ${r.reason}`)
            .join("; ")}.`,
        );
        lines.push(
          `Declared deliverables (claim using the EXACT string): ${declared
            .map((d) => `"${d}"`)
            .join(", ")}. Re-claim with the exact declared deliverable, the current git rev-parse HEAD, and the committed evidence paths.`,
        );
      }
      return {
        content: [{ type: "text", text: lines.join(" ") }],
        details: { claims: accepted },
      };
    },
  });
}
