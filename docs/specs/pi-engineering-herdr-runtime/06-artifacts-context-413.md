# 06 — Artifacts, Context and 413 Prevention
Workers return structured WorkerResult: status, concise summary, artifact refs, changed files, commits, tests, findings, questions, recommendations and metrics. Raw transcripts remain separately retrievable and are never automatically injected into parent context.

Discover context/request limits dynamically from InferWeave/runtime metadata. Budget both tokens and serialized request bytes with safety headroom. Strategies: direct, retrieve-on-demand, summarize, split, delegate/fan-out.

Implement reusable fan-out/synthesis for images, UI references, large specs and code analysis. Children receive one scoped reference plus rubric/schema; synthesis receives structured reports, not all transcripts/originals. Add a regression reproducing the prior 413 pattern and prove transformation occurs before HTTP submission. Do not solve this by merely increasing server limits.
