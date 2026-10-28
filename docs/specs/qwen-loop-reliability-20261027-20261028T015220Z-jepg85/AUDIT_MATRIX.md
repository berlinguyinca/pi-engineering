# Known code vs gap — verify deployed HEAD

| Repo path | Prior evidence | Action |
|---|---|---|
| pi-engineering/src/guard/GenerationGuard.ts | Sentence/text repetition; no-progress; narration detection | Extend typed channel detection, tests |
| pi-engineering/src/guard/streamText.ts | `thinking_*` intentionally excluded | Audit adapter events; add reasoning stream support with no double-charge |
| pi-engineering/src/guard/config.ts | Defaults: repeated threshold 4/window 8; 4000 worker no-progress; 2000 narration; 12000 interactive; three recovery attempts; semantic similarity disabled | Preserve compatibility, add channel/role/model policy |
| pi-engineering/src/guard/RecoveryController.ts | Corrective prompt, recovery ladder, compaction, model fallback | Improve failure-specific prompts and verified retry outcomes |
| pi-engineering/src/aps/supervisor.ts | Semantic fingerprints, loop candidates, prevention callback | Reuse; ensure meaningful progress and correct wiring |
| pi-engineering/src/aps/recovery.ts | Deterministic replan/compaction | Reuse; avoid duplicate logic |
| pi-engineering/src/aps/observability.ts | Aggregate counts and recovery rates | Extend existing events and dashboards |
| pi-engineering/src/workers/PiWorkerExecutor.ts | Instantiates GenerationGuard; APS prevention callback | Verify abort reaches active request and task resumes |
| pi-engineering/extensions/index.ts | Interactive guard | Verify interactive session parity |
| pi-engineering/src/workers/streamStall.ts | Detects stream silence, not active repetitive output | Keep distinct |
| pi-engineering/src/inference/recovery.ts | Retry/fallback/parking for infrastructure failures | Do not conflate with degenerations |
| herdr-engineering/herdr_engineering/{checkpoint,recovery,pi_recovery}.py | Checkpoint and session recovery | Reuse through existing API |
| herdr-engineering/docs/specs/0200-agent-inspector.md | Agent inspection UI spec | Enhance inspector, not parallel UI |
| InferWeave/inferweave | Connected GitHub index but initial code search inconclusive | Inspect gateway stream/cancel runtime profiles and benchmark protocol |

Existing tests: `test/unit/generation-guard.test.ts`, `test/unit/guard-stream-feed.test.ts`, `test/unit/aps-loop-prevention.test.ts`, `test/unit/aps-recovery.test.ts`, `test/integration/loop-mitigation.test.ts`. Extend these before introducing new fixtures/tests.

## Questions that must be answered with evidence
1. In real Qwen loop samples, which channels consume 32K tokens?
2. Are Qwen thinking tokens emitted as `thinking_delta`, other provider-specific event shapes, hidden in text, or not accessible?
3. Does abort actually cancel server-side decoding, and how is release measured?
4. Are guards enabled in deployed worker AND interactive workflows and with what overrides?
5. Does an aborted generation remain in context or get truncated safely on the next attempt?
6. Can task evidence determine true progress after a tool action?
7. Are prompt variant/replay/benchmark facilities already implemented in InferWeave or Pi?
8. What edits are already underway in other worktrees/branches? Avoid collisions.
