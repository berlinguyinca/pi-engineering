# Specification: Qwen Streaming Loop Prevention, Recovery, and Prompt Optimization

## Goals
Prevent costly 32K-token degenerate generations in Qwen models while preserving legitimate long reasoning, generated code and long-form content; resume tasks without losing verified progress; optimize prompts using measurable replay evidence. Support other model families without coupling to Qwen.

## Non-goals
No parallel Loop Guardian framework, duplicate APS, new orchestrator, wholesale gateway rewrite, blind prompt rewrites, GPU eviction, replacing the existing UI, or self-modifying system prompts without tested promotion.

## Architecture and responsibility
- Pi `src/guard/`: own **per-generation stream detection**, typed channel accounting, abort decisions, bounded recovery orchestration.
- Pi `src/aps/`: own **cross-turn/tool-action progress detection**, loop prevention, task-level replan/compaction, event classification.
- Pi `src/workers/` and `extensions/index.ts`: invoke both guards via current event hooks; recover with actual, verified task state. Use existing inference recovery for transport/admission faults, not for deterministic model degeneration.
- InferWeave: inspect real streaming event serialization, API cancellation propagation, token usage and stop semantics. Modify only missing adapter/control contracts, behind backward-compatible capability detection.
- Herdr: use existing agent inspector, recovery, event, scheduler and telemetry paths. Do not duplicate schemas, components or services.

## Phase-zero source and environment audit — mandatory
Identify canonical repos and deployed revisions; read `AGENTS.md`, operational docs and tests. Inspect relevant running Qwen profiles, runtime adapters and streamed events (visible text, thinking/reasoning, tool calls, errors). Compare deployed configuration with defaults. Reproduce one 32K loop or use archived logs; redact sensitive content. Identify whether actual loop is in reasoning, visible text, repeated tool actions, request retries, wrong chat template or generation stop signals. Do not assume causes. Record evidence and a change impact matrix.

## Streaming detection
1. Extend existing `guardFeedFor()`/GenerationGuard with a **typed stream channel** (`visible_text`, `reasoning`, `tool_argument`, lifecycle), retaining delta/snapshot deduplication; do not accidentally charge accumulated snapshots repeatedly.
2. Use independent rolling windows, approximate-or-exact token usage with explicit confidence/source, normalized n-grams/sentences and repeating suffix checks. Reasoning signals need model-adapter mapping, not indiscriminate string concatenation.
3. Track actual verified progress from tool results/edits/checkpoint outcomes, not just an announced tool call. Preserve role-specific exemptions for explanation, code, review and summarization tasks.
4. Separate safeguards for max reasoning tokens without progress, visible narration without progress, total output hard cap, and time/token efficiency. Defaults are configurable per model/role/runtime, with an explicit safety ceiling and warn/abort bands. Start conservative; calibrate using regression traces.
5. Only interrupt repeated substantive content or sustained stagnation; do not abort legitimate repeated lines in code, tests, data tables, pagination, or long creative answers. Never treat a final-answer-start marker alone as proof of completed work.
6. Preserve diagnostics: model and runtime IDs, model profile/chat template version, thinking mode, sampling, channel, detector, thresholds, requested/actual token usage, last real action, attempt and trace fingerprint. Redact secrets and bound retained text.

## Cancellation semantics
On abort, cancel the active Pi model request, propagate AbortSignal to adapter/gateway and serving runtime, verify stream close and capacity release. Protect against race with tool execution, repeated finalization, stale generation after cancellation, and duplicate side effects. Never infer server-side cancellation merely from client disconnect. Log cancellation acknowledgment or uncertainty. No GPU teardown / unloading needed; especially **do not disturb the dual R9700 Pro GPUs used for ongoing work**. Prefer the available RTX 4090 on bender for optional live testing; never allocate it without checking actual resource policy/availability.

## Recovery
Reuse `src/guard/RecoveryController.ts` and `src/aps/recovery.ts`: first corrective in-session steering, then targeted prompt+context repair, then capability-eligible alternative model if needed, capped retry budget and cooloffs. Idempotent continuation from verified checkpoints; preserve task, worktree, ledger, tool results, versioned prompt recipe and outstanding work. Never feed back raw degenerate 32K prefix. Distinguish model degeneration from transport 429/503/stalls; defer the latter to the existing inference ladder. If a retry reproduces the same fingerprint, escalate strategy instead of same failed retry. Show user actionable blocked state when exhausted.

## Prompt optimizer
- Add a **recipe registry** layered over existing prompts; every recipe has name, version, scope (model family/profile, runtime, role, failure type), parent hash, author/source and rollback pointer.
- Safe candidate transformations: action-first instruction, reduced duplicate directions, bounded reasoning request, task decomposition, evidence summary, tool formatting corrections, model-supported thinking mode, and measured sampling adjustments.
- Never rewrite immutable system/safety rules, developer instructions, user task or tool policy. Candidate generation may use a reviewer model but may not auto-promote untested rules.
- Use offline replay and paired comparisons. Score primarily verified milestone completion; secondarily recovery rate, wasted tokens, latency and false aborts. Enforce holdout traces and minimal sample size; promote only after reproducible improvement without correctness regression. Provide rollback and dry-run.
- Store prompt and sampling experiment provenance without private raw secrets.

## Dashboard and telemetry
Extend the existing Herdr agent inspector and Pi metrics. Show detector/reason/channel, model/runtime/host, token usage on abort, intervention and retry, last verified progress, model fallback, result, recipe version, replay comparison and uncertain cancellation status. Existing APS observability remains canonical; derive charts from events rather than creating separate parallel counters. Label any `max_output - tokens_at_abort` savings estimate as **potential**, not verified saved tokens.

## Config compatibility
Use existing `PI_GUARD_*` variables and configuration shapes where possible. New channel-specific tunables must have safe defaults, feature flags and documented precedence (global -> role -> model profile -> invocation), with stable backward compatibility. Semantic similarity currently off; benchmark before enabling. Do not blindly set Qwen greedy decoding or repetition penalties; test against documented model-specific defaults.

## Security and operational boundaries
No prompts/logs with credentials, user secrets, or unredacted private repo code in public telemetry. No external calls by default. Recovery must respect host blacklist/manual-only scheduler and active GPU allocations. Human approval for disruptive moves and policy promotion where required. Correlate events by stable run/session/attempt and idempotency IDs.
