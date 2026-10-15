import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CheckpointProgressClaim } from "./checkpointProgressTool.ts";

/** Stable tool name (the executor's activity filter depends on it). */
export const CLAIM_DELIVERABLE_TOOL_NAME = "claim_deliverable";

const canonical = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Tell the broker that declared deliverables are finished. The worker supplies
 * ONLY the deliverable name (matched ignoring case and whitespace); the broker
 * binds the claim to the worker branch tip when it checkpoints, and accepts it
 * only if the branch holds commits past the mission base.
 */
export function createClaimDeliverableTool(declaredDeliverables: readonly string[]): ReturnType<typeof defineTool> {
  const declared = [...declaredDeliverables];
  return defineTool({
    name: CLAIM_DELIVERABLE_TOOL_NAME,
    label: "Claim Deliverable",
    description: `Mark declared deliverables as finished. Takes only the deliverable names; no commit SHA or paths. Declared deliverables: ${declared.map((d) => `"${d}"`).join(", ")}.`,
    promptSnippet: "Mark a declared deliverable as finished",
    promptGuidelines: ["Call claim_deliverable with the declared deliverable names once their work is done."],
    parameters: Type.Object({
      deliverables: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 32 }),
    }),
    async execute(_toolCallId, params) {
      const accepted: CheckpointProgressClaim[] = [];
      const unknown: string[] = [];
      for (const name of params.deliverables) {
        const match = declared.find((d) => canonical(d) === canonical(name));
        if (match) {
          if (!accepted.some((c) => c.deliverable === match))
            accepted.push({
              deliverable: match,
              candidateSha: "",
              evidencePaths: [],
              artifactRefs: [],
              tipBound: true,
            });
        } else unknown.push(name);
      }
      const lines: string[] = [];
      if (accepted.length > 0)
        lines.push(
          `Recorded ${accepted.map((c) => `"${c.deliverable}"`).join(", ")}. The broker accepts each only once your branch has a committed file no earlier claim used.`,
        );
      if (unknown.length > 0)
        lines.push(
          `NOT declared: ${unknown.map((n) => `"${n}"`).join(", ")}. Declared deliverables: ${declared.map((d) => `"${d}"`).join(", ")}.`,
        );
      return { content: [{ type: "text", text: lines.join(" ") }], details: { claims: accepted } };
    },
  });
}
