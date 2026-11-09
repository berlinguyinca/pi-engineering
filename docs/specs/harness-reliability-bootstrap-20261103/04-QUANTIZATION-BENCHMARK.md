# Is it the harness or quantization? Experimental protocol

## Independent variables
- Minimal single-task Pi versus full harness (same base SHA, task contract, prompt, tools and decoding).
- Same family/weights with different Q8 / Q6 / Q4 quantization **if actually available**; do not invent endpoints.
- Context buckets ~8k, 32k, 64k, 100k if confirmed supported.
- KV-cache quantization separately (where configurable), never conflate with weight quantization.

## Model telemetry required
Actual provider and model id, weights/version hash if known, quant method, backend/runtime/version, effective context, KV-cache dtype, sampling settings, prompts hash, tool support, error rates, response tool calls, memory use. Unknown is explicit.

## Protocol
1. Use 5 small frozen tasks, 5+ repetitions per condition where feasible. Isolate each run with same clean base tree.
2. Compare acceptance pass rate, off-scope edits, first drift point, repeated calls, wall time, tokens and tool-call correctness.
3. Use a deterministic evaluator for hard scopes/tests. Blind review semantic drift against labeled cases and report disagreement.
4. Present confidence intervals or counts, not unsupported precision.
5. Never infer that Q4 causes drift from one failing mission, a backend 400, or an HTTP 200. Distinguish model-quality degradation from gateway deployment failures.

## Scheduling
No role requires an always-on dedicated model. Prefer Qwen 27B for difficult planning/review and Flash for isolated coding or low-cost evaluation. Deterministic guardrails run without any model. Review can be sequential; same-model fresh context offers weaker independence than cross-family review.
