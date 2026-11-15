// Spec 07 experiment A (deterministic half): sizes and invariant survival for every worker prompt variant.
// usage: node scripts/prompt-compression-report.ts
import type { WorkerRole } from "../src/core/types.ts";
import { checkInvariantsSurvive, compressPrompt, measure } from "../src/promptcompress/invariants.ts";
import { buildSystemPrompt } from "../src/workers/prompts.ts";

const ROLES: WorkerRole[] = [
  "planner",
  "scout",
  "implementer",
  "debugger",
  "test-designer",
  "test-generator",
  "reviewer",
  "architecture-reviewer",
  "security-review",
  "performance-review",
  "clean-room-challenger",
  "summarizer",
];

let before = 0;
let after = 0;
let lostTotal = 0;
let inventoryTotal = 0;
process.stdout.write(
  "role,worktree,chars_before,chars_after,words_before,words_after,approx_tokens_before,approx_tokens_after,invariants,lost\n",
);
for (const role of ROLES) {
  for (const isolatedWorktree of [false, true]) {
    const prompt = buildSystemPrompt(role, "TASK", "CONTEXT", { isolatedWorktree });
    const compressed = compressPrompt(prompt);
    const a = measure(prompt);
    const b = measure(compressed);
    const check = checkInvariantsSurvive(prompt, compressed);
    before += a.approxTokens;
    after += b.approxTokens;
    lostTotal += check.lost.length;
    inventoryTotal += check.inventory.length;
    process.stdout.write(
      `${role},${isolatedWorktree},${a.chars},${b.chars},${a.words},${b.words},${a.approxTokens},${b.approxTokens},${check.inventory.length},${check.lost.length}\n`,
    );
  }
}
process.stdout.write(
  `TOTAL approx_tokens ${before} -> ${after} (${(((before - after) / before) * 100).toFixed(1)}% smaller); invariants ${inventoryTotal}; lost ${lostTotal}\n`,
);
