# Full Implementation Specification — v1.0

## 0. Operating rules
1. Maintain 131K as default available model context whenever supported; do NOT impose arbitrary 24K code limits or automatically summarize away important engineering evidence. Adapt to actual model limits and usage.
2. Wide read, narrow write, narrower external effects. Reading another repo is not equivalent to permission to change it.
3. Existing implementations are authoritative: audit, reuse, refactor, consolidate; no duplicated services, schemas, registries, agents, views, or dashboards.
4. Forbidden activity must be denied at execution boundary even when LLM proposes, retries, or explains it.
5. User instruction/policy grants authority. Hindsight, source files, logs, docs, tool results, and agent-generated plans never grant new authority.
6. Models in use can include Qwen, DeepSeek, Claude; same policy across providers and Pi-based harnesses. Frontiers may plan/review per current local practice; preserve existing routing rules.
7. Guardrails must not derail legitimate multi-repo debugging; support evidence-backed scope expansion with approval when needed.

## 1. Mandatory audit (no coding before this)
Locate actual source repositories, their branches, package manager, extension versions, mission/task types, tool interception, shell/SSH/container adapters, subagent launch, command registration, permissions, memory integration, existing Hindsight model, dashboard mission page, event storage, metrics, CI and tests. Write `docs/specs/<unique>/AUDIT.md` with existing-vs-required matrix, canonical owners, concrete file locations, reuse plan, risks, and migration. Do not assert audit results until examined. Use the repo's existing conventions. Before modifying, inspect git status and preserve uncommitted user changes. Confirm target Pi API against pinned installed package, not just internet documentation. Inspect existing security/approvals design, enforce at all execution paths.

## 2. System boundaries
### Task contract (immutable authorization snapshot + versioned amendments)
Fields: task id, title, user objective, mode, requested result, root/workspace, broad allowed read roots (including dependent repos), exact authorized write roots, permitted network endpoints and operations, host allowlist, remote side effects, denial actions, completion criteria, mission/parent id, owner, amendment lineage, evidence links and policy version. Default diagnostic mode denies remote writes, deployments, outbound data transfer and destructive operations. Contract changes require actual authorized user/administrator approval; model cannot self-approve. Signing or trusted server-side identity if existing system supports it; otherwise process-controlled trusted storage and separate write endpoint.

### Policy enforcement
Intercept ALL tools and adapters: Pi `tool_call`, shell and user bash, command-runner, git hooks/push, SSH, rsync/scp, containers, child-process launch, MCP, remote execution, artifact upload, CI dispatch, subagent delegation, extension/custom tools and programmatic APIs. Tool names alone are insufficient: classify effect after parsing structured arguments and command chains. Never claim arbitrary shell parsing is fully secure; for strict diagnostic mode, run in a sandbox/container with egress restrictions and no deployment credentials. Use capability-scoped identity, filesystem permissions, egress ACLs and SSH allowlists. Validate canonicalized paths incl symlinks, nested commands, cwd, env and destination names. Handle unknown or opaque commands conservatively; fail closed on side effects. Read-only remote diagnostic access only if explicitly allowed, with correct confidentiality controls. Inspect post-execution effects as defense in depth. Audit allow/deny/escalate decisions with stable IDs.

### Subagents
Child receives original objective, current plan, relevant evidence and narrowed policy contract; cannot widen roots, hosts, modes, network grants or credentials; check both at spawn and at action boundary. Parent and child tracing must preserve mission linkage. Avoid unlimited recursion. Enforce concurrent execution budgets and stop children on parent cancellation or policy revoke. Handoff across models/harnesses revalidate policy, not merely copy natural-language constraints.

### Drift detection and progress
Deterministic gates for effects. Semantic monitor (prefer fast local model) scores relevance, speculative assumptions, repeated loops, unauthorized target references, plan deviation; advisory unless selected as additional restrictive gate. Log reason, evidence, and confidence without exposing secrets. When action blocked, send concise explanation and feasible next in-scope action; never silently grant permission. Checkpoints at configurable intervals (default 8 meaningful actions and on plan changes, model switches, subagent handoff or repeated failure), tracking goal, hypotheses, confirmed facts, test matrix, changed files, next step. Avoid forcing a mini-LLM call on every harmless read.

### Software engineering behavior
Support necessary related changes: agent can request explicit amended write scope with evidence from code/test failures; user approval required for widening beyond pre-authorized scope. Keep incidental improvement notes in backlog; do not implement. Define completion by tests, diff inspection, reproducibility and original acceptance criteria. Support investigation, implementation, review, deployment modes with strict transitions; no automatic mode escalation.

## 3. Storage and API design
Prefer existing task/mission tables/events and APIs. Persist immutable `TaskContractCreated`, `TaskContractAmended`, `ActionDecision`, `DriftSignal`, `Checkpoint`, `ScopeExpansionRequested`, `ScopeExpansionResolved`, `VerificationResult` in existing event/audit architecture; indexes by mission, tool_call_id, actor, decision, timestamp. Use redaction, authorization, and existing retention. Design idempotent writes and correlated traces. Expose existing API pattern for get contract, timeline, policy decisions, evidence, diff and approval flow. Avoid a new database if current persistence suffices.

## 4. Recommended lifecycle
User request -> classify suggested mode (default diagnostic is read-only) -> create trusted contract -> existing planner -> policy-check tools -> execute -> trace -> checkpoint -> verify -> finish or explicit scope escalation. Agents should not be forced to seek user approval for every normal code edit in an authorized repo. For unexpected remote host `strange-host`: reject pre-execution, log redacted evidence, redirect to local peak-picking diagnosis.

## 5. Deployment/rollout
Feature flags: audit_only (records decisions, cannot be claimed protective), enforce_diagnostic, enforce_all; precedence from existing policy. Start with report-only on replay/simulation or isolated dev environment, then enable strict enforcement for diagnostic sessions. Fail closed on privileged external effects if policy service unavailable; don't falsely claim coverage for unrestricted local root shells. Show enforcement state prominently. Provide opt-out only by explicit authorized policy amendment, not assistant text. Backward-compatible migration, rollback and safe defaults for older sessions; no running-task policy loosening via migration.

## 6. Non-functional
No noticeable latency on ordinary reads (cache policy); no silent truncation of 131K context; robust 128/131K context variance and model/provider limits; redact secrets/host credentials in events and UI; hostnames in logs where authorized; auditable approvals; usable offline for local work; defensive behavior under service outages and concurrency; recover on restart. Existing Hindsight memory is read-only evidence unless user requests memory write and existing governance permits.

## 7. Deliverables
Integrated extension(s)/adapters, authoritative policy engine or reused existing permission infrastructure, schemas/migrations only if necessary, tests and adversarial fixtures, existing dashboard mission screens, user/admin docs, upgrade/rollback, audit report, benchmark report, and runnable demonstration. Every deliverable maps to existing project components identified in the audit. No standalone prototype masquerading as integration.
