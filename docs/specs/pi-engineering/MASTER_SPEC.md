# ⚠️ IMPLEMENTATION SCOPE — READ FIRST

`pi-engineering` MUST NOT build Pi Web, Plannotator, Pi, pi-subagents, OpenViking, InferWeave, AutoSpec, Blackhole, or MCP servers. These are external/upstream tools/services/projects.

This repository implements **integration, configuration, engineering policy, adapters, extensions where supported, normalized state/events, and validation around those tools**.

Read `support/EXTERNAL_TOOLS_AND_OWNERSHIP.md` before implementation. If any later wording sounds like "build Pi Web" or "build Plannotator", interpret it as **integrate/configure the existing external tool**, unless the task explicitly targets that external repository.

# Pi Engineering Platform — Master Implementation Spec
**Revision:** 2026-09-15 · **Status:** normative

## Objective
Build the complete Pi engineering platform around Pi: one multi-project control plane capable of coordinating 30–40 concurrent engineering agents across dozens of repositories, with 50-worker load validation. It must be observable, steerable, secure, recoverable, memory-aware, Docker-first, and inference-provider independent.

## Authoritative architecture
- **Pi** = engineering agent runtime and responsive parent orchestrator.
- **pi-subagents** = preferred child orchestration. Inspect upstream first; reuse its run/fanout/lanes/steering/background/fresh-context/worktree/output-schema/limits/FleetView primitives before inventing anything.
- **Pi Web** = primary multi-project operator UI.
- **Pi Forge** = OUT OF SCOPE. Do not evaluate, install, integrate, configure, vendor, or implement it.
- **Plannotator** = plan annotation/approval gate; not an executor.
- **AutoSpec** = specification/work-item policy consumer of Pi; never another process supervisor.
- **OpenViking** = mandatory shared durable engineering/project memory.
- **Blackhole** = local/private per-Pi-session compaction/recall only.
- **PostgreSQL/EventStore** = authoritative runtime history/state.
- **InferWeave** = inference placement, model residency, GPU grouping, batching, queueing, fair-share, dynamic capacity and backpressure.
- **Docker** = default packaging for surrounding services and isolation where practical.

This package supersedes older shared-Blackhole-server/shared-filesystem designs. Never implement them.

## Explicit exclusion: Pi Forge
Pi Forge is **not part of this project**. Do not inspect it for reusable features, install it, configure it, integrate it, vendor it, fork it, link to it as a required workflow component, or implement compatibility specifically for it. Pi Web is the external operator UI selected for this architecture.

## Topology
```text
User/API -> Pi Web
              |---- Plannotator
              |---- AutoSpec
              v
        Pi orchestrator (responsive)
              v
          pi-subagents
       /       |       \
   Pi child Pi child ... Pi child
   Blackhole Blackhole   Blackhole
       \       |       /
         OpenViking shared memory

Pi sessions -> provider abstraction -> InferWeave / eligible providers
Runs/tasks/workers -> EventStore + telemetry
Parallel mutators -> isolated worktrees + sandbox/permission policy
```

## Canonical runtime model
`Workspace -> Project -> Repository -> Work Item -> Run -> Task graph -> Worker -> Session/Worktree`.

The parent stays interactive. Meaningful implementation, debugging, tests, review, docs and visual validation are delegated to addressable children. No opaque background execution path. Workers have lifecycle, heartbeat, structured events, limits, logs and cancellation/restart/steering.

## Multi-project UI
One Pi Web deployment manages dozens of projects. Normalize Git remotes so worktrees remain one project. Show project selector, cross-project active runs, history, work graphs, workers, logs/activity, tests, diffs, reviews, model/routing state, memory health, artifacts and human interventions.

## Plannotator
Modes: `interactive`, `autonomous`, `policy`, `disabled`.
Interactive waits for approve/annotate/reject. Autonomous persists the plan and records explicit policy bypass; it never fakes approval. Policy gates configured risk classes. Pending plan decisions survive restart. Run Plannotator as a Docker service near the control plane.

## Concurrency
Design for 30–40 concurrent Pi workers; load-test 50. Scheduling considers dependencies, write conflicts, role/project limits, provider/InferWeave capacity, host/container resources, priority, fairness and budgets. Never launch all ready tasks blindly.

## Memory
Exactly two agent-memory layers:
1. Blackhole: local/private/session-aware.
2. OpenViking: shared durable cross-session/process/machine/project.

Every parent/child gets a distinct OpenViking session tied to canonical project identity. Bootstrap only compact relevant context (~4k–8k configurable), retrieve more on demand, and commit at phase/run boundaries. Promote validated decisions, confirmed repo facts, failure/solution pairs, test lessons and accepted reviewer findings. Never promote chain-of-thought, secrets, speculative guesses or giant logs. Explicit emergency offline mode uses a durable outbox; autonomous runs do not silently become memoryless.

## Review/worktrees
Concurrent mutators use isolated worktrees. Candidates/reviewers/challengers have separate Pi sessions and Blackhole state. Fresh reviewers get requirements, accepted architecture, code/diff, tests and permitted project memory—not implementer private history, self-ratings, other verdicts or hidden reasoning.

## Models/context/InferWeave
Discover context window, max output, reasoning, vision, tool support and availability dynamically from provider/InferWeave metadata where possible; cache with TTL/version and safe fallback. Remove fixed 260k assumptions. Stable session IDs enable affinity.

InferWeave uses **seats**, not equal-cost fixed slots. One active logical branch is one seat, while admission accounts for context/KV/VRAM/RAM/model residency/compute/queue/fairness/safety. Respect `503 + Retry-After` for capacity and `429` for user/policy limits. Pi never maps GPUs to models.

Role routing is capability based. Eligible discovered families can include Qwen 3.8 variants, GLM-5.3-Flash, DeepSeek variants, Claude, Codex and future models. Preserve reviewer independence during fallback.

## Security
Layer identity/project auth, run policy, role/tool policy, Pi permissions, capability ceilings, isolated worktrees, container/sandbox boundaries, minimal secret injection, outbound network policy and audit. High-risk operations may require approval even in autonomous mode. Control APIs cannot bypass worker permissions.

## MCP/tools
MCP discovery never grants permission. Use project/role allowlists. Support the existing metabolomics LCB MCP and future MassWiki, ChemLake and CTSLite services through generic registration.

## Persistence and prompt telemetry
Persist projects, work items, runs, tasks/dependencies, workers/sessions, events, messages/interventions, tool calls, routing, tests, reviews, artifacts, commits/PRs and metric summaries. Large artifacts may use S3-compatible storage.

Prompt telemetry includes correlation IDs, role/model/provider, template/version, input/output hashes, configurable redacted/encrypted payload references, token counts, latency, tools, context occupancy, compactions, routing and outcome. Raw prompt retention is configurable/access-controlled. Never log secrets.

## Observability
Pi Web + CLI/API expose work graph, agent tree, activity, blockers, model/provider, tokens/context, worktree/diff, commands, tests, reviews, heartbeats, queue/admission state, memory health, interventions and artifacts. Prefer OpenTelemetry/Prometheus. Never require hidden chain-of-thought.

## AutoSpec/CI
`AutoSpec -> Pi plan -> optional Plannotator -> pi-subagents implementation -> tests -> fresh review -> fixes -> revalidation -> docs -> commit/PR by policy -> OpenViking commit/promotion`.
A patch is not completion.

## Deployment
Reference Docker Compose: control API, Pi Web, PostgreSQL, Plannotator, optional S3-compatible object storage and observability. Workers can be dynamic containers/processes. OpenViking and InferWeave remain external. Remote workers establish authenticated outbound connections; no public inbound port requirement.

## Implementation rule
First inspect every relevant checkout under the parent directory: Pi, pi-subagents, Pi Web, Plannotator, AutoSpec, InferWeave integrations and existing specs. Produce an existing/partial/missing/superseded gap matrix. Reuse upstream first. Use subagents for parallel inspection and independent review. Continue through implementation and validation; do not stop at planning.

## Global definition of done
Pi Web manages many projects/runs; Plannotator gate + autonomous bypass work; pi-subagents powers child work; parent remains responsive; 30–40 concurrency is supported and 50-worker test exists; worktrees isolate mutations; workers are observable/steerable/recoverable; OpenViking shared + Blackhole local is enforced; reviewer isolation is tested; dynamic model/context discovery works; InferWeave backpressure works; permissions/sandboxing are enforced; prompt/event telemetry is queryable/redacted; AutoSpec does not duplicate Pi; MCP tools are scoped; local/remote workers share one contract; recovery/integration/E2E tests pass; no obsolete shared-Blackhole gateway exists.
