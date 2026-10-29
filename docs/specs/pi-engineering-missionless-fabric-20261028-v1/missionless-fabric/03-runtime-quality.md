# 03 — Runtime semantics, quality and recovery

## Direct execution
Foreground interactive execution is first class, with change observation and policy-aware evidence. Prefer existing Pi SDK entry, GitRepo, Verifier and Ledger. Direct means no Mission; NOT no policy. Explicitly define whether edits occur in user's working tree vs isolated worktree; never silently overwrite dirty files. Honor repository write/read scopes and operator permissions.

## Delegation and handoff
Use existing worker executor/subagents and Herdr handoff/forks. Before delegation assess: independent objective, expected speed benefit, available capacity, token/cost budget, write collision, model specialization. Each run gets bounded context package with task goal, scoped files, commitments, completed deliverables, evidence refs, open blockers and diff state. No full unbounded parent transcripts. Track lineage and owner; receiver acknowledges handoff and validates repo SHA and unresolved work. Handoff is immutable but can be superseded by new event.

## Quality policies
Evaluate after material changes to files, not only at initial prompt. Preserve deterministic validation, independent review for configured risk, security/migration/dependency/public API gates, and revision identity. Cache evidence by (repo identity, candidate commit/tree hash, gate type/version, tool configuration, environment fingerprint). Invalidate any affected evidence after mutation or merge; don't reuse stale tests. Reviewer independence and no self-approval remain explicit. Separate code completed, review passed, PR opened, merged, deployed.

## Recovery and ownership
Checkpoints contain durable refs to actual state: base/head commit, clean/dirty/untracked paths, artifacts, completed deliverables, tests, pending work, context summary, running processes, active leases. On recovery reconcile git/worktree and journal before assigning successor. Generation-fenced lease, CAS revision and idempotency protect against duplicate commits, dual writers or stale owners. A model failure/429/worker loss should first pause or migrate only affected run; use existing single-owner retry/admission mechanism. User pause always prevents automatic resumption. No fixed mission-wide timeout by default; bounded attempts/silence detection/capacity circuit-breaker. Preserve successful partial outputs.

## Risk and authority
Approval for production deploys, credential changes, external sends, destructive operations and sensitive merges must use task-scoped actor permissions and explicit policy; supervisor suggestions do not expand authority. Immutable audit and redaction. Prompt injection from external PR/email/artifact content cannot grant actions. Allow optional auto-merge only within explicit narrowly scoped low-risk policies with passing CI and independent review.

## No hidden work
Each run has a discoverable owner/task, last heartbeat vs last meaningful progress, current activity, logs and cancellation endpoint. If service offline: show 'state unknown' not a healthy indicator. Distinguish waiting for human, gateway, model, CI, tool or file lock using diagnostics, but keep compact public status.
