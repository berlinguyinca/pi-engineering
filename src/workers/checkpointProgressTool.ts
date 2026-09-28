import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface CheckpointProgressClaim {
  deliverable: string;
  candidateSha: string;
  evidencePaths: string[];
  artifactRefs: string[];
}

export const checkpointProgressTool = defineTool({
  name: "checkpoint_progress",
  label: "Checkpoint Progress",
  description:
    "Record completed declared deliverables after committing them. Claims are accepted only when candidate SHA and committed path evidence match the broker's Git snapshot.",
  promptSnippet: "Record durable candidate-bound progress after each coherent commit",
  promptGuidelines: [
    "After committing a coherent subset, run git rev-parse HEAD and call checkpoint_progress.",
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
    const claims: CheckpointProgressClaim[] = params.claims.map((claim) => ({
      deliverable: claim.deliverable,
      candidateSha: claim.candidate_sha,
      evidencePaths: [...claim.evidence_paths],
      artifactRefs: [...(claim.artifact_refs ?? [])],
    }));
    return {
      content: [
        { type: "text", text: `Recorded ${claims.length} checkpoint progress claim(s) for broker validation.` },
      ],
      details: { claims },
    };
  },
});
