# Pi Engineering Runtime: Ledger + Tournament Orchestration

**Status:** Implementation specification  
**Primary target project:** `pi-engineering` (recommended repository: `inferweave/pi-engineering`)  
**Primary agent harness:** Pi  
**Standalone mode:** required; no AutoSpec or InferWeave dependency  
**Optional orchestration consumer:** AutoSpec  
**Optional execution fabric:** InferWeave  
**Spec version:** 2.0  
**Date:** 2026-09-12

---

## 1. Executive Summary

This specification defines **Pi Engineering**, a general-purpose software-engineering runtime for the Pi coding harness. It is designed first for ordinary Pi installations and normal interactive coding sessions, including single-user “vibe coding,” while also scaling upward into AutoSpec-driven multi-repository orchestration and InferWeave-backed distributed execution.

The design is inspired in part by GVS5H's fresh-context manager/worker scaffold, but generalizes it from single-file competitive-programming tasks into repository-scale engineering with semantic retrieval, isolated candidates, deterministic verification, clean-room challengers, task DAGs, and adaptive multi-agent execution.

The central design principle is:

> **The model reasons; the harness remembers, retrieves, executes, measures, verifies, and coordinates.**

Pi Engineering MUST work usefully when the user has only:

```text
Pi + one model endpoint + one Git repository
```

In that minimum configuration it still provides:

- task-scoped fresh-context workers;
- a lightweight Engineering Ledger;
- lazy artifact handling;
- repository and symbol intelligence;
- targeted test execution;
- independent review via fresh sessions;
- worktree/candidate isolation when useful;
- smart handoff and compaction;
- automatic risk-based escalation.

When additional models or compute are available, Pi Engineering can add parallel candidates, clean-room challengers, independent specialist reviewers, adversarial testing, and candidate tournaments. When AutoSpec is present, the same runtime gains specification/issue/DAG orchestration across repositories. When InferWeave is present, the same runtime gains capability-aware distributed model routing and resource scheduling.

The architecture therefore has three separable layers:

```text
                       AutoSpec (optional)
                specs / issues / project DAGs
                              |
                              v
                    +--------------------+
                    |   Pi Engineering   |
                    |--------------------|
                    | Context Broker     |
                    | Engineering Ledger |
                    | Workers/Subagents  |
                    | Candidate Manager  |
                    | Verification       |
                    | Smart Compaction   |
                    | Risk Escalation    |
                    +---------+----------+
                              |
                              v
                             Pi
                              |
                    model/provider boundary
                       /             \
                      v               v
              direct/local APIs   InferWeave
                                  (optional)
```

**No core Pi Engineering feature may require AutoSpec or InferWeave.** Those systems are capability providers and higher-level consumers, not prerequisites.

The target behavior is an evidence-driven engineering environment that feels lightweight in everyday Pi use but can scale into a many-agent software-engineering system when the task and available compute justify it.

---

# 2. Motivation

## 2.1 Problem

Large coding agents are commonly made “more capable” by giving them more context:

- more repository files;
- more conversation history;
- more logs;
- more architecture documents;
- more tool definitions;
- more previous agent reasoning.

That approach does not scale well.

Large contexts:

1. consume KV-cache/VRAM;
2. reduce concurrency;
3. increase prefill latency;
4. make relevant facts less salient;
5. increase the chance of stale or contradictory state;
6. encourage agents to reason over prose rather than inspect authoritative sources;
7. cause repeated transmission of information the model does not need;
8. make failure analysis difficult because state becomes implicit in transcripts;
9. encourage long, meandering generations;
10. couple unrelated tasks together.

Pi Engineering should instead provide **large effective knowledge with small active context**.

A worker should receive information because the current task requires it, not because the information exists somewhere in the project.

## 2.2 GVS5H insight

GVS5H demonstrates a useful pattern:

- every role is invoked in a fresh context;
- state lives in a shared workspace rather than an ever-growing conversation;
- a manager creates and curates tasks;
- workers operate on bounded tasks;
- notes preserve useful information across invocations;
- context and output lengths remain bounded;
- verification feeds objective failures back into orchestration.

Its paper reports that this scaffold can substantially improve some smaller or less self-organizing models, and explicitly attributes recurring gains to context management and decomposition.

However, GVS5H also documents limitations that are directly relevant to software engineering:

- workers inherit accumulated notes and can become anchored on an early wrong approach;
- a worker can overwrite a previously correct solution;
- verification is limited;
- the task loop is sequential;
- all roles use one evolving artifact;
- task state is compact but largely untyped prose;
- there is no repository-scale semantic retrieval layer;
- there is no multi-repository conflict scheduling;
- there is no long-lived engineering knowledge model.

The paper itself proposes two important extensions: fresh-perspective workers and stronger verification. Pi Engineering should implement both, then go substantially further.

## 2.3 Desired outcome

A typical worker should operate with approximately 8k–25k active tokens even if the project has millions of lines of code and months of prior agent activity.

The overall orchestration may consume hundreds of thousands of aggregate tokens across many workers, while no individual worker needs to hold the entire project or run history.

This allows Pi Engineering to turn available compute into engineering quality rather than one gigantic serial context, while still working efficiently when only one model endpoint is available.

---

# 3. Goals

The system MUST:

0. Work as a standalone Pi package in an ordinary Git repository with no AutoSpec or InferWeave installation.

1. Keep routine Pi worker contexts small and task-specific.
2. Externalize durable state from model transcripts.
3. Run independent workers in fresh Pi sessions.
4. Support many concurrent tasks where dependencies permit.
5. Preserve a known-good incumbent until a challenger is verified.
6. Treat model statements as claims, not evidence.
7. Require machine-generated evidence for code correctness gates.
8. Separate implementation from independent review.
9. Support clean-room workers that do not inherit previous reasoning.
10. Build task context from semantic repository knowledge rather than bulk file dumping.
11. Provide deterministic and auditable orchestration state.
12. Survive crashes and resume safely.
13. Work across multiple repositories and organizations.
14. Route workers by capability rather than hard-coded provider where possible.
15. Integrate with InferWeave for resource-aware model selection.
16. Preserve AutoSpec’s optional Spec -> Define -> Plan -> Implement -> Verify lifecycle.
17. Produce telemetry suitable for the AutoSpec CI/CD dashboard.
18. Enforce configurable token, time, cost, and compute budgets.
19. Use adaptive verification effort based on risk.
20. Expose explicit concurrency information so idle agents can be saturated safely.
21. Degrade gracefully to sequential fresh-context workers when only one model endpoint is available.
22. Escalate orchestration effort according to task risk instead of spawning a swarm for every edit.
23. Preserve a simple interactive Pi experience; advanced orchestration SHOULD be mostly automatic.
24. Allow a normal Pi session to opt into explicit commands such as review, challenge, verify, handoff, context inspection, and alternative-candidate generation.
25. Permit AutoSpec to adopt or extend session state without changing the core ledger/candidate formats.

---

# 4. Non-Goals

Version 1 MUST NOT require:

- training a custom orchestrator;
- reinforcement learning;
- a learned reward model;
- replacing git;
- replacing existing language compilers or test runners;
- a proprietary vector database;
- storing hidden model chain-of-thought;
- trusting an LLM as the sole correctness judge;
- requiring InferWeave in order to function;
- requiring AutoSpec in order to function;
- requiring multiple models or multiple GPUs;
- forcing every small coding task through a multi-agent tournament;
- merging code automatically when repository policy requires human approval.

The design may later support learned routing or ranking, but the first implementation must remain useful with deterministic rules and off-the-shelf models.

---

# 5. Core Invariants

These are hard architectural invariants.

## INV-001 — Externalized state

Persistent project/work-item state MUST NOT depend on a Pi transcript being available.

## INV-002 — Fresh workers

Every task worker MUST run in a fresh logical Pi session unless the task explicitly declares continuity as necessary.

## INV-003 — Immutable incumbent

A worker MUST NOT directly overwrite the known-good incumbent branch/worktree/artifact.

## INV-004 — Candidate isolation

Every implementation candidate MUST execute in an isolated git worktree, branch, container overlay, or equivalent sandbox.

## INV-005 — Evidence before promotion

A candidate MUST pass required deterministic verification gates before becoming eligible for promotion.

## INV-006 — Claims are not evidence

Agent-produced status text such as “tests pass,” “fixed,” or “correct” MUST NOT satisfy verification gates unless backed by captured tool execution evidence.

## INV-007 — Separation of duties

The same logical model assignment MUST NOT both implement and independently approve the same work item. Configuration may allow the same model family in exceptional environments, but the default must use a different model/provider or at minimum a fresh clean-room reviewer session.

## INV-008 — Typed memory

Hypotheses MUST NOT be silently promoted into facts, invariants, or architecture decisions.

## INV-009 — Bounded context

Every worker role MUST have an explicit target context budget and maximum context budget.

## INV-010 — Bounded orchestration

Every work item MUST have explicit maximum rounds, maximum candidate count, wall-clock budget, token budget, or a higher-level resource policy that supplies them.

## INV-011 — No-progress guard

Repeatedly attempting semantically equivalent work without new evidence MUST cause escalation, approach diversification, or termination.

## INV-012 — Reproducible decisions

Promotion/rejection decisions MUST be reconstructable from ledger events and evidence artifacts.

## INV-013 — Standalone core

No core Pi Engineering capability may require AutoSpec, InferWeave, a hosted control plane, or more than one model endpoint.

## INV-014 — Graceful degradation

When parallel compute or model diversity is unavailable, the same workflow MUST degrade to sequential fresh-context workers without losing correctness semantics.

## INV-015 — Risk-proportional effort

The runtime MUST NOT invoke heavyweight candidate tournaments, specialist reviewers, or full verification suites for low-risk edits unless explicitly requested.

## INV-016 — Interactive continuity

A user MUST be able to start from a normal interactive Pi prompt and receive engineering assistance without first creating a formal specification, issue, or AutoSpec work item.

---

# 6. High-Level Architecture

## 6.1 Layered architecture

```text
                          AutoSpec Adapter
                              optional
                                 |
                                 v
                    +--------------------------+
                    |      Pi Engineering      |
                    |--------------------------|
                    | Session Risk Classifier  |
                    | Context Broker           |
                    | Engineering Ledger       |
                    | Worker/Subagent Runtime  |
                    | Candidate/Worktree Mgr   |
                    | Verification Farm        |
                    | Artifact Store           |
                    | Handoff/Compaction       |
                    | Scheduler/Tournament     |
                    +------------+-------------+
                                 |
                                 v
                                Pi
                                 |
                         AgentRuntime interface
                      /            |             \
                     v             v              v
               direct model    local server    InferWeave
                                                optional
```

Pi Engineering owns the reusable engineering semantics. AutoSpec owns formal specification/project orchestration. InferWeave owns compute/model routing. Pi remains the agent harness.

## 6.2 Standalone interactive path

A normal Pi user may simply run:

```text
pi
> Add cursor pagination to this API without breaking existing clients.
```

The runtime may internally perform:

```text
classify risk
 -> inspect repository
 -> retrieve relevant symbols/tests
 -> record compact facts/invariants
 -> optionally spawn fresh scout
 -> implement candidate
 -> run targeted verification
 -> optionally spawn clean-room reviewer
 -> fix findings
 -> broader verification when warranted
 -> present verified diff and evidence
```

The user does not need a spec, GitHub issue, AutoSpec server, InferWeave gateway, or multiple models.

## 6.3 AutoSpec path

When AutoSpec is available it may create structured work items and dependency DAGs, then dispatch them through the same Pi Engineering APIs. AutoSpec MUST NOT own duplicate implementations of the ledger, context broker, candidate manager, verifier, or Pi worker runtime.

## 6.4 InferWeave path

When InferWeave is available, Pi Engineering expresses capability requests rather than hard-coding model names. InferWeave may satisfy those requests using local, remote, Slurm, or heterogeneous inference resources. When it is absent, direct Pi model/provider configuration remains fully supported.

## 6.5 Operating modes

The runtime supports three adaptive modes:

| Mode | Typical trigger | Default behavior |
|---|---|---|
| Interactive | ordinary small/medium Pi request | minimal retrieval, one implementer, targeted verification |
| Engineering | refactor, risky feature, complex bug | fresh scouts, test planning, isolated candidate, independent review |
| AutoSpec | formal spec/issue/project work | persistent DAGs, parallel workers, tournaments, integration queue |

These are policies over the same engine, not separate implementations.

---

# 7. Component Model

The implementation SHOULD be split into a reusable Pi package/runtime plus optional adapters. The recommended repository is `inferweave/pi-engineering`, but the package MUST remain usable independently of InferWeave.

```text
pi-engineering/
  packages/
    core/
      ledger/
      contextbroker/
      candidates/
      worktrees/
      verifier/
      tournament/
      scheduler/
      budget/
      policy/
      events/
      artifacts/
      telemetry/
      git/

    pi-package/
      extensions/
      skills/
      prompts/

    runtime/
      sdk/
      rpc/
      cli/

    adapters/
      autospec/
      inferweave/

  schemas/
    session.schema.json
    work-item.schema.json
    task.schema.json
    ledger-event.schema.json
    candidate.schema.json
    evidence.schema.json
    context-package.schema.json

  docs/
    architecture/
    specs/

  test/
    unit/
    integration/
    fixtures/
```

The **core package MUST NOT import AutoSpec or InferWeave code**. Adapter dependency direction is one-way:

```text
AutoSpec adapter  ---> Pi Engineering Core <--- InferWeave adapter
                               |
                               v
                              Pi
```

TypeScript is the preferred implementation language for the Pi-native package because Pi extensions, SDK integration, commands, and UI hooks are TypeScript-native. Durable external orchestration services such as AutoSpec MAY remain Go and communicate through RPC/SDK adapter boundaries.

A future Go control plane MUST consume Pi Engineering rather than reimplement its session/ledger/candidate semantics.

---

# 8. Pi Integration Strategy

## 8.1 Preferred boundary

Pi exposes interactive, SDK, and RPC modes. Pi Engineering SHOULD use Pi-native extensions for the normal interactive experience and expose SDK/RPC interfaces for external orchestrators such as AutoSpec.

```go
type AgentRuntime interface {
    Start(ctx context.Context, req AgentRequest) (AgentSession, error)
    Run(ctx context.Context, req AgentRequest) (AgentResult, error)
    Cancel(ctx context.Context, runID string) error
}
```

Recommended implementation order:

1. build the project-local/global Pi package for interactive use;
2. implement the core session/ledger/candidate interfaces independently of AutoSpec;
3. expose SDK integration for in-process orchestration;
4. expose RPC integration for process/language isolation;
5. add the AutoSpec adapter;
6. add the InferWeave routing adapter.

## 8.2 Pi resources

Create a standalone Pi Engineering package containing:

### Extensions

- `engineering-context.ts`
- `engineering-artifacts.ts`
- `engineering-evidence.ts`
- `engineering-budget.ts`
- `engineering-diagnostics.ts`
- `engineering-ledger.ts`
- `engineering-test.ts`
- `engineering-handoff.ts`

### Skills

- `implementation`
- `debugging`
- `test-design`
- `review`
- `architecture-review`
- `security-review`
- `performance-review`
- `ui-review`
- language/framework-specific skills

### Prompts

Role prompts MUST be compact and versioned.

Pi’s available extension APIs allow custom tools, lifecycle interception, session persistence hooks, and custom compaction. Pi’s SDK supports programmatic sessions and custom resource loading, while RPC supports headless subprocess integration. These mechanisms should be used instead of modifying Pi core.

## 8.3 Dynamic tool minimization

Every role receives only the tools required for that role.

Example:

### Implementer

```text
repo_search
symbol
references
read_slice
edit
bash_limited
test
compiler
ledger_claim
artifact_read
```

### Reviewer

```text
repo_search
symbol
references
diff
history
test_evidence
ledger_read
artifact_read
```

### Test designer

```text
repo_search
symbol
references
coverage
existing_tests
ledger_read
```

### Clean-room challenger

```text
repo_search
symbol
references
read_slice
edit
bash_limited
test
```

Reducing tool schemas lowers the permanent prompt footprint and improves selection reliability.

## 8.4 Standalone installation and discovery

The package SHOULD support both global and project-local Pi installation. A representative installation UX is:

```bash
pi install npm:@inferweave/pi-engineering
# or project-local
pi install -l npm:@inferweave/pi-engineering
```

The exact published package name may change, but the installation MUST use standard Pi package mechanisms rather than a custom Pi fork. Pi packages can bundle extensions, skills, and prompts, and Pi discovers project/global resources using its normal configuration.

On first use in a repository the runtime SHOULD cheaply detect:

```text
git repository
languages/frameworks
LSP availability
test commands
build commands
coverage tooling
worktree support
configured model/provider(s)
optional InferWeave endpoint
optional AutoSpec metadata
```

Detection MUST be cached and refreshable.

## 8.5 Explicit interactive commands

The package SHOULD expose a small command surface for advanced users while keeping normal behavior automatic:

```text
/engineer <goal>      run adaptive engineering workflow
/review               fresh-context independent review
/challenge            clean-room challenge of current approach
/alternatives [N]     build/compare isolated alternative candidates
/verify               run risk-appropriate verification
/test-impact           explain and run impacted tests
/handoff               create a fresh focused continuation
/ledger                show compact engineering state
/context               show current context budget/sources
/candidates            show incumbent/challenger status
```

Commands MUST NOT be required for ordinary use.

## 8.6 Single-model operation

With only one configured model, role separation is implemented using fresh independent sessions and context firewalls. The runtime SHOULD prefer different model families when available, but MUST remain useful with one model.

## 8.7 AutoSpec adapter

The AutoSpec adapter maps formal specs, plans, GitHub issues, and cross-repository DAG nodes onto Pi Engineering work items/tasks. It adds project-scale persistence and coordination but does not change the worker/candidate/evidence contracts.

## 8.8 InferWeave adapter

The InferWeave adapter translates role capability requests into distributed model-routing requests. It is optional and replaceable by direct Pi provider selection.

---

# 9. Engineering Ledger

## 9.1 Purpose

The Engineering Ledger is the durable shared memory for orchestration.

It replaces long agent transcripts as the authoritative representation of:

- requirements;
- facts;
- hypotheses;
- decisions;
- invariants;
- tasks;
- candidates;
- evidence;
- findings;
- test obligations;
- failures;
- promotions;
- rollbacks;
- resource usage.

The ledger MUST be machine-readable, append-only at the event layer, and queryable as materialized current state.

## 9.2 Event-sourced model

Persist immutable events:

```json
{
  "event_id": "evt_01K...",
  "work_item_id": "WI-1842",
  "timestamp": "2026-09-12T18:02:11Z",
  "actor": {
    "type": "agent",
    "run_id": "run_782",
    "role": "implementer"
  },
  "type": "hypothesis.created",
  "payload": {
    "hypothesis_id": "HYP-41",
    "claim": "RetryPlanner drops affinity metadata during provider fallback",
    "confidence": 0.62
  }
}
```

Materialized views may be stored in SQLite/PostgreSQL for fast access.

## 9.3 Ledger entity types

At minimum:

### Requirement

```yaml
id: REQ-104
source: spec://routing#6.7
text: Preserve session affinity across reconnect unless original provider is unavailable.
priority: must
status: accepted
```

### Invariant

```yaml
id: INV-204
scope:
  - gateway/router
rule: A reconnect must preserve logical session identity.
evidence:
  - spec://routing#6.7
status: verified
```

### Fact

```yaml
id: FACT-287
claim: SessionRouter.route is the only writer of affinity node_id during normal routing.
status: verified
evidence:
  - symbol://SessionRouter.route
  - refs://affinity.node_id
```

### Hypothesis

```yaml
id: HYP-41
claim: RetryPlanner drops affinity metadata during provider fallback.
status: open
confidence: 0.62
evidence:
  - symbol://RetryPlanner.retry
```

### Decision

```yaml
id: DEC-77
text: Store affinity ownership transfer atomically with retry state.
rationale: Prevent transient loss during reconnect.
status: accepted
supersedes: []
```

### Finding

```yaml
id: FIND-993
severity: high
category: correctness
claim: Candidate C14 breaks reconnect behavior when provider A disappears between retries.
evidence:
  - test-run://TR-8821
candidate_id: C14
status: open
```

### Test obligation

```yaml
id: TESTOB-18
requirement_id: REQ-104
scenario: provider disappears between retry attempt and affinity restoration
kind: integration
status: implemented
```

## 9.4 Memory promotion rules

The following promotion must be explicit:

```text
hypothesis -> fact
hypothesis -> decision input
finding -> resolved
candidate -> incumbent
scratch note -> durable knowledge
```

An agent MUST NOT convert a hypothesis to a fact merely by restating it.

Promotion requires one of:

- deterministic evidence;
- authoritative source inspection;
- accepted design decision;
- independent verification policy.

## 9.5 Scratch memory

Workers may maintain ephemeral scratch data, but it MUST be automatically expired unless promoted.

Examples:

- possible bug causes;
- alternative APIs;
- incomplete investigations;
- speculative optimizations.

This prevents speculative model output from accumulating as permanent truth.

---

# 10. Context Broker

## 10.1 Purpose

The Context Broker constructs the smallest useful context package for a task.

It is responsible for turning a project containing potentially millions of lines and large historical state into a targeted context bundle.

## 10.2 Context sources

The broker SHOULD integrate:

- LSP servers;
- tree-sitter or equivalent AST parsers;
- ripgrep;
- git history/blame;
- repository dependency graph;
- build-system graph;
- test discovery;
- test coverage maps;
- static-analysis results;
- API schemas;
- OpenAPI/GraphQL/protobuf definitions;
- AutoSpec specs;
- ledger entities;
- CI history;
- package dependency metadata;
- generated architecture indexes.

## 10.3 Semantic tools

Pi workers SHOULD request semantic data through compact tools such as:

```text
repo_map(query)
symbol(id)
references(id)
callers(id)
callees(id)
tests_for(symbols)
history(symbol_or_path)
architecture(scope)
invariants(scope)
diagnostics(paths)
changed_symbols(candidate)
impact_analysis(candidate)
coverage_for(symbol)
artifact(id)
```

## 10.4 Lazy expansion

Tools SHOULD return compact summaries and artifact references by default.

Bad:

```text
run tests -> inject 45,000 log lines into prompt
```

Good:

```json
{
  "run_id": "TR-8821",
  "status": "failed",
  "passed": 428,
  "failed": 3,
  "skipped": 12,
  "duration_ms": 38422,
  "failures": [
    "RoutingFallbackTest.should_preserve_affinity",
    "QuotaTest.should_fallback_provider",
    "RetryTest.should_not_retry_auth_failure"
  ],
  "artifact": "test-run://TR-8821"
}
```

The worker may then request one failure.

## 10.5 Context scoring

Every context item SHOULD have:

```yaml
relevance_score: 0.92
authority: compiler|spec|test|source|ledger|agent
freshness: current|stale
estimated_tokens: 320
required: true|false
```

The broker fills the context budget in priority order.

## 10.6 Default token budgets

Recommended initial targets:

| Role | Target | Hard max |
|---|---:|---:|
| Planner | 12k | 32k |
| Scout | 10k | 24k |
| Implementer | 16k | 40k |
| Debugger | 18k | 48k |
| Test designer | 10k | 24k |
| Reviewer | 10k | 24k |
| Architecture reviewer | 16k | 40k |
| Clean-room challenger | 12k | 32k |
| UI verifier | 12k + images | 32k |
| Summarizer | 4k | 8k |

These are targets, not fixed model context-window requirements.

The orchestrator MUST record actual context size and reason for budget escalation.

---

# 11. Task DAG

## 11.1 Replace sequential manager loop

GVS5H selects a single next task. Pi Engineering MUST generalize this to a dependency graph when a task decomposes into independent work; low-risk interactive edits may remain single-task.

Example:

```text
               T1 architecture
              /  |         \
             /   |          \
          T2 API T3 storage T4 telemetry
             \      /          |
              \    /           |
               T5 tests       T6 dashboard
                    \          /
                     \        /
                      T7 integration
```

## 11.2 Task schema

```yaml
id: TASK-204
work_item_id: WI-1842
title: Preserve affinity through retry
kind: implementation
scope:
  repositories:
    - inferweave-gateway
  paths:
    - pkg/router/
  symbols:
    - RetryPlanner.retry
    - SessionRouter.route

depends_on:
  - TASK-201
blocks:
  - TASK-220
conflicts_with:
  - TASK-206
parallelizable: true
risk: high
context_profile: implementation
verification_profile: routing-high
status: ready
```

## 11.3 Conflict detection

Tasks may run concurrently only if the scheduler believes their write sets are compatible.

Inputs include:

- declared `scope.paths`;
- predicted symbols;
- build-system modules;
- database migration ownership;
- generated files;
- shared config files;
- known semantic conflicts.

Path overlap alone is insufficient. Semantic conflicts should also be tracked.

## 11.4 Dynamic DAG revision

Workers and verifiers may discover new tasks.

New tasks are proposals until planner/scheduler policy accepts them.

The planner MUST deduplicate semantically equivalent tasks.

## 11.5 Saturation policy

The scheduler SHOULD maximize useful concurrency while respecting:

- dependency readiness;
- merge conflicts;
- model capacity;
- GPU availability;
- verification bottlenecks;
- repository resource locks;
- external API quotas;
- priority.

Do not create meaningless parallel work solely to occupy agents.

---

# 12. Worker Classes

## 12.1 Informed worker

Receives:

- task goal;
- acceptance criteria;
- relevant verified ledger facts;
- applicable decisions/invariants;
- current incumbent diff/state if required;
- targeted repository context;
- existing test obligations;
- limited previous findings.

Does NOT receive arbitrary historical transcript text.

## 12.2 Clean-room challenger

Receives:

- original requirement;
- acceptance criteria;
- authoritative architecture constraints;
- repository access;
- no prior candidate reasoning;
- no previous implementation rationale;
- no unverified accumulated notes.

Purpose:

- escape anchoring;
- independently derive an approach;
- protect against a manager/worker consensus built on a bad premise.

For high-risk work, at least one clean-room challenger SHOULD be mandatory.

## 12.3 Scout

Read-only worker that investigates:

- relevant symbols;
- likely change locations;
- architecture constraints;
- previous changes;
- testing implications.

Output is a compact structured context recommendation, not a code patch.

## 12.4 Implementer

Produces a candidate in an isolated worktree.

MUST NOT approve its own candidate.

## 12.5 Test designer

Runs before or independently from implementation for medium/high-risk work.

Outputs test obligations and invariants, not just test code.

## 12.6 Test generator

Implements approved test obligations and adversarial cases.

## 12.7 Debugger

Receives failing evidence and the minimal related code surface.

May create a child candidate from a failed candidate.

## 12.8 Reviewer

Receives:

- requirement;
- acceptance criteria;
- relevant invariants;
- candidate diff;
- selected surrounding symbols;
- deterministic evidence summary.

It MUST NOT inherit the implementer transcript.

## 12.9 Specialist reviewers

Optional based on change profile:

- security;
- performance;
- API compatibility;
- database migration;
- concurrency;
- UI/UX;
- accessibility;
- observability;
- architecture.

---

# 13. Candidate Model

## 13.1 Immutable candidate lineage

Each implementation attempt creates a candidate.

```yaml
id: CAND-1842-007
work_item_id: WI-1842
task_id: TASK-204
parent: CAND-1842-003
base_commit: 3f106b64...
branch: autospec/WI-1842/C007
worktree: /worktrees/WI-1842/C007
producer:
  run_id: RUN-882
  role: implementer
  model_route: coding-high
status: verifying
```

A failed candidate is never silently mutated into a passing candidate. A fix creates a child candidate.

This gives a searchable lineage:

```text
C001
 |- C002 rejected: compile
 |- C003
     |- C005 rejected: integration
     |- C007 promoted
 |- C004 rejected: architecture
```

## 13.2 Known-good incumbent

The incumbent is the best accepted state for the work item.

It may be:

- the repository base branch before any accepted work;
- a previously promoted candidate;
- an integration branch containing already-accepted dependent tasks.

Challengers are compared against the incumbent.

## 13.3 Worktree isolation

Recommended implementation:

```bash
git worktree add <path> -b <candidate-branch> <base-commit>
```

Each candidate MUST have:

- independent filesystem state;
- independent uncommitted changes;
- captured patch/diff;
- build/test artifacts;
- cleanup lifecycle.

Containers may wrap worktrees for stronger isolation.

## 13.4 Candidate artifacts

Persist:

- patch;
- changed symbols;
- commit hash if committed;
- compile evidence;
- test evidence;
- static-analysis evidence;
- benchmarks;
- coverage delta;
- reviewer findings;
- token/runtime usage.

---

# 14. Candidate Tournament

## 14.1 Purpose

Multiple candidates should compete when the task is uncertain or high-risk.

Do not ask an LLM to compare obviously broken candidates.

Tournament order:

```text
candidate generation
     |
     v
hard deterministic gates
     |
     v
quality metrics
     |
     v
specialist gates
     |
     v
LLM comparative review
     |
     v
promotion decision
```

## 14.2 Hard gates

Examples:

- repository still builds;
- required tests pass;
- no required formatter violation;
- no forbidden dependency introduced;
- no new compiler/type errors;
- required API compatibility holds;
- migration validation passes;
- no policy violation.

Any hard-gate failure makes the candidate ineligible unless the work item explicitly expects an intermediate failure.

## 14.3 Objective ranking metrics

Candidates that pass hard gates may be compared using:

- targeted test score;
- full-test score;
- mutation score;
- coverage delta;
- benchmark delta;
- binary size;
- memory/CPU impact;
- static complexity delta;
- duplicate-code delta;
- lint debt;
- changed LOC;
- API surface change;
- dependency count;
- reviewer severity count.

Do not blindly optimize for fewer lines or lower complexity if it harms clarity/correctness.

## 14.4 LLM comparative review

After objective filtering, an independent judge may compare remaining candidates for:

- maintainability;
- architectural fit;
- unnecessary abstraction;
- duplicated behavior;
- future extensibility;
- idiomatic language/framework use;
- test clarity.

The judge MUST receive evidence and diff summaries but MUST NOT receive which candidate came from which model unless needed for debugging.

## 14.5 Tie handling

If candidates are equivalent:

1. prefer smaller semantic change;
2. prefer fewer new dependencies;
3. prefer lower measured complexity;
4. prefer incumbent-compatible design;
5. otherwise require human or architecture-review decision.

---

# 15. Verification Farm

## 15.1 Principle

> An agent saying a result is correct is not verification.

The verifier is a first-class service.

## 15.2 Verification profiles

Each task has a profile.

Example:

```yaml
name: routing-high
stages:
  - compile
  - typecheck
  - lint
  - targeted-unit
  - targeted-integration
  - property-tests
  - race-detector
  - full-module-tests
  - static-analysis
```

## 15.3 Staged execution

Run cheap high-signal stages first.

Example:

```text
1. compile/typecheck          3 s
2. impacted unit tests        8 s
3. impacted integration      45 s
4. static analysis           20 s
5. full module               2 min
6. entire repository         14 min
```

Stop early on hard failures where later stages add no useful evidence.

## 15.4 Test-impact analysis

Use:

- changed symbols;
- call graph;
- historical coverage;
- package/module graph;
- previous CI failures;
- explicitly mapped requirements.

Return a ranked test plan rather than “run everything” by default.

Full suites still run before merge when policy requires them.

## 15.5 Adversarial test generation

For medium/high-risk changes, spawn independent test workers to propose:

- boundary cases;
- malformed inputs;
- concurrency races;
- retry/failure cases;
- stale state;
- partial network failures;
- permission failures;
- version skew;
- serialization compatibility;
- rollback behavior;
- resource exhaustion.

Generated tests are proposals until they compile and demonstrate a meaningful obligation.

## 15.6 Property-based testing

Use where suitable.

The test designer should identify invariants such as:

```text
route(session) repeated without topology change returns same provider
```

and translate them into property tests.

## 15.7 Fuzzing

Enable for parsers, protocol handlers, serializers, boundary APIs, and security-sensitive input handling.

## 15.8 Mutation testing

Use selectively to measure test strength for important business logic.

Mutation testing is too expensive for every edit, so it should be risk-triggered or scheduled.

## 15.9 Differential testing

When replacing algorithms or implementations, execute old and new implementations against the same generated corpus where possible.

## 15.10 Performance evidence

For performance-sensitive work, promotion MUST compare against baseline and define tolerated regression thresholds.

---

# 16. Test Design Independence

For medium/high-risk tasks:

```text
Requirement
   |\
   | \----> Test Designer ----> Test Obligations
   |
   +------> Implementer -------> Candidate
                                  |
                                  v
                         Test Generator/Verifier
```

The implementer may add tests, but it does not control the entire definition of success.

The test designer SHOULD run before implementation when requirements are sufficiently clear.

---

# 17. Context Firewall

## 17.1 Purpose

Prevent irrelevant or biased prior reasoning from propagating across roles.

## 17.2 Allowed transfer

Between agents, prefer structured artifacts:

```yaml
objective: Fix retry affinity loss.
verified_facts:
  - FACT-287
invariants:
  - INV-204
files:
  - pkg/router/retry.go
  - pkg/router/session.go
tests:
  - TESTOB-18
open_questions:
  - Does ownership transfer need persistence transactionality?
```

Avoid transferring raw transcript history.

## 17.3 Worker output contract

Every worker SHOULD return a compact structure:

```yaml
status: completed|blocked|failed
summary: ...
claims:
  - ...
evidence_refs:
  - ...
new_hypotheses:
  - ...
proposed_tasks:
  - ...
artifacts:
  - ...
```

Implementation workers additionally return candidate ID, not a prose dump of the entire codebase.

---

# 18. Handoffs and Compaction

## 18.1 Handoff over transcript growth

Long Pi sessions SHOULD be terminated and handed off rather than endlessly compacted.

Recommended phase boundaries:

```text
Discovery
  -> handoff
Design
  -> handoff
Implementation
  -> handoff
Debug/Verification
  -> handoff
Review
```

## 18.2 Handoff package

```yaml
work_item: WI-1842
phase: implementation
objective: Preserve session affinity across provider fallback.
requirements:
  - REQ-104
invariants:
  - INV-204
accepted_decisions:
  - DEC-77
current_incumbent: CAND-1842-003
candidate: CAND-1842-007
verification:
  targeted_tests: pass
  integration: pending
open_findings: []
open_questions:
  - Confirm persistence behavior under restart.
```

## 18.3 Pi compaction

Pi supports explicit compaction and custom compaction behavior. Pi Engineering SHOULD use custom compaction only inside a bounded worker session.

Compaction summary content MUST prioritize:

1. current task;
2. edits made;
3. authoritative constraints;
4. test evidence;
5. unresolved failures;
6. artifact references.

Do not preserve conversational filler.

---

# 19. Planning Model

## 19.1 Lifecycle

Pi Engineering supports a lightweight interactive lifecycle by default:

```text
User intent
   -> classify risk
   -> inspect/retrieve
   -> plan only as much as needed
   -> implement candidate
   -> verify
   -> independent review when policy requires
   -> present/promote
```

When AutoSpec is present, it may formalize the same work into:

```text
User intent
   -> SPEC
   -> AUTOSPEC DEFINE
   -> IMPLEMENTATION PLAN
   -> TASK DAG
   -> Pi Engineering workers/candidates
   -> VERIFY
   -> REVIEW
   -> INTEGRATE
```

The formal spec defines what/why/constraints. AutoSpec Define converts the spec into explicit requirements, invariants, interfaces, risks, and acceptance criteria, while Pi Engineering remains responsible for worker execution, context, candidates, evidence, and verification semantics.

The plan converts those defined requirements into implementation work and dependency ordering.

## 19.2 Planner output

The planner MUST produce machine-readable tasks, not only prose.

It must identify:

- dependencies;
- possible concurrency;
- expected write scope;
- test obligations;
- likely specialists;
- risk level;
- merge/integration points;
- required architecture decisions.

## 19.3 Plan challenge

High-risk plans SHOULD be independently challenged before implementation.

A clean-room planner may receive only the spec + repository index and propose a competing plan.

The architecture reviewer chooses or synthesizes after comparing concrete tradeoffs.

---

# 20. Risk-Adaptive Orchestration

## 20.1 Risk inputs

Risk score may include:

- security sensitivity;
- data loss potential;
- production criticality;
- concurrency;
- migration/schema change;
- API compatibility;
- blast radius;
- novelty;
- test coverage;
- repository familiarity;
- changed LOC estimate;
- subsystem historical failure rate.

## 20.2 Profiles

### LOW

Examples: typo, doc update, isolated obvious test fix.

```text
1 implementer
cheap verification
light review or policy exemption
```

### MEDIUM

```text
1 implementer
independent test design
verification
fresh reviewer
```

### HIGH

```text
2+ implementation candidates
at least 1 clean-room challenger
adversarial tests
specialist verification
independent reviewer
```

### CRITICAL

```text
heterogeneous model candidates
architecture review
security review
full deterministic suite
performance/regression gates
human approval if configured
```

---

# 21. Model Routing

## 21.1 Capability-based request

Pi Engineering SHOULD request capabilities rather than provider names when a routing layer is available. In standalone mode it may map the same capability profile onto Pi’s currently selected/configured model.

```yaml
role: implementation
capabilities:
  coding: high
  tool_use: required
  reasoning: medium
context:
  target: 16000
  max: 40000
preferences:
  latency: interactive
  locality: local-preferred
  cost: low
separation:
  cannot_match_run_role:
    - reviewer
```

## 21.2 InferWeave integration (optional)

Direct Pi provider/model routing is the baseline. When configured, InferWeave may choose the concrete route from:

- local R9700 nodes;
- RTX 4090 node;
- other local GPUs;
- Slurm/HPC resources;
- external providers;
- subscription-backed model adapters.

The orchestration system MUST remain functional without InferWeave by using a static model routing config.

## 21.3 Quota/capacity fallback

Routing MUST support:

```text
preferred model unavailable
 -> next eligible model of same role class
 -> next provider
 -> local fallback
```

Fallback must still obey separation-of-duties rules.

## 21.4 Model diversity

For candidate tournaments, model diversity SHOULD be configurable.

Example high-risk policy:

```yaml
candidates:
  count: 3
  diversity:
    min_model_families: 2
review:
  must_differ_from_winner_family: true
```

If only one model family is available, clean-room context isolation still provides some diversity.

---

# 22. Scheduling and Resource Control

## 22.1 Scheduler inputs

- ready tasks;
- dependencies;
- conflict sets;
- model capacity;
- GPU capacity;
- provider quota;
- estimated context length;
- expected run time;
- task priority;
- verification queue;
- candidate limit;
- cost/token budget.

## 22.2 Backpressure

Do not launch 50 implementation workers if verification can process only two candidates at a time.

The scheduler SHOULD track queue pressure and balance:

```text
planning -> implementation -> verification -> review -> integration
```

## 22.3 Fairness

Within shared InferWeave environments, orchestration should respect InferWeave priority/fairness mechanisms rather than monopolizing every model slot.

## 22.4 Speculative execution

Permitted for high-value uncertain tasks.

Example:

- launch two approaches in parallel;
- cancel slower candidate only after faster candidate passes high-confidence gates;
- preserve partial findings if cancellation occurs.

---

# 23. Budget Manager

Every work item MUST have a budget envelope.

```yaml
budget:
  max_wall_clock_minutes: 90
  max_agent_runs: 40
  max_candidates: 8
  max_input_tokens: 500000
  max_output_tokens: 250000
  max_cloud_cost_usd: 10
```

Self-hosted token budgets still matter because they consume throughput.

## 23.1 Budget escalation

If the budget is exhausted:

- preserve all evidence;
- produce a structured partial result;
- state unresolved findings;
- request escalation or human decision depending on policy.

Do not silently continue indefinitely.

## 23.2 Marginal-value stopping

Stop generating additional candidates when:

- incumbent passes all required evidence;
- independent review finds no material issues;
- extra candidates have low expected value;
- risk policy is satisfied.

---

# 24. Verification Evidence Schema

```yaml
id: EVID-8821
candidate_id: CAND-1842-007
type: test_run
tool: go-test
command: go test ./pkg/router/... -run 'Session|Retry'
started_at: ...
finished_at: ...
exit_code: 0
summary:
  passed: 182
  failed: 0
  skipped: 4
artifacts:
  stdout: artifact://...
  stderr: artifact://...
  junit: artifact://...
trust: deterministic
```

Evidence trust levels:

```text
authoritative  specification/compiler/protocol schema
deterministic  command/test/static tool output
observed       repository inspection or runtime telemetry
reviewed       accepted independent LLM analysis
unverified     agent claim/hypothesis
```

Promotion policy should prefer authoritative/deterministic evidence.

---

# 25. Artifact Store

Large outputs MUST live outside prompts.

Store:

- build logs;
- test logs;
- screenshots;
- benchmark data;
- coverage reports;
- compiler output;
- diffs;
- patches;
- generated docs;
- traces;
- crash dumps;
- browser recordings.

Every artifact receives a stable URI:

```text
artifact://build/B-827/log
artifact://test/TR-8821/junit
artifact://candidate/C007/diff
artifact://ui/U-188/screenshot/3
```

Tools return summaries + these references.

---

# 26. LSP and Repository Intelligence

The Context Broker SHOULD run language-specific LSPs where useful.

Examples:

- gopls;
- rust-analyzer;
- pyright/pylsp;
- TypeScript language server;
- JDT LS;
- Metals for Scala;
- clangd.

Use LSP for:

- symbol definitions;
- references;
- signatures;
- diagnostics;
- implementations;
- rename impact;
- workspace symbols.

Do not make an LLM infer information a language server can state deterministically.

Tree-sitter provides fast structural fallback/indexing where full LSP is unavailable.

---

# 27. Code Quality and Architecture Gates

The system MUST discourage generated spaghetti code and meaningless abstraction.

Possible deterministic measures:

- cyclomatic complexity;
- cognitive complexity;
- duplicate code;
- unused code;
- dependency cycles;
- excessive public API growth;
- giant files/functions;
- test coverage regression;
- static-analysis warnings;
- architecture dependency violations.

LLM architecture review SHOULD inspect:

- unnecessary layers;
- getter/setter proliferation;
- invented framework patterns;
- duplication of existing capabilities;
- premature abstraction;
- violation of repository conventions;
- nonsensical features not tied to requirements.

Architecture findings MUST cite concrete source/diff evidence.

---

# 28. UI/UX Verification

For UI-affecting tasks:

1. build/run application;
2. execute browser automation;
3. capture screenshots at required breakpoints;
4. compare expected behavior;
5. inspect accessibility tree where possible;
6. run visual review with a vision-capable independent model;
7. record artifacts in evidence store.

A UI worker MUST NOT claim success based only on source inspection when the UI can be executed.

---

# 29. Security

## 29.1 Workspace isolation

Worker commands run in candidate worktrees/containers with configured filesystem/network boundaries.

## 29.2 Secret handling

Secrets MUST NOT be injected into model prompts.

Commands receive credentials through process/environment mechanisms only when required.

Logs must redact known secret patterns.

## 29.3 Tool policy

Potentially destructive tools require policy gates.

Examples:

- deployment;
- database mutation;
- package publishing;
- git push to protected refs;
- infrastructure changes.

## 29.4 Untrusted repository instructions

Repository content may contain prompt-like text. Tool output and files are data, not authority. Only configured system/project policy may alter agent permissions.

---

# 30. Multi-Repository and Multi-Organization Support

A work item may span:

```yaml
repositories:
  - org: inferweave
    repo: gateway
    ref: main
  - org: inferweave
    repo: protocol
    ref: main
  - org: berlinguyinca
    repo: autospec
    ref: master
```

The planner MUST model cross-repo dependencies.

Candidates may be grouped into an atomic integration set:

```text
C-protocol-4
    |
C-gateway-9
    |
C-autospec-2
```

Verification runs against a workspace manifest pinning all candidate commits.

---

# 31. Integration and Merge Queue

## 31.1 Promotion levels

```text
candidate
 -> verified candidate
 -> reviewed candidate
 -> integration candidate
 -> merge-ready
 -> merged
```

## 31.2 Integration rebase

Before merge, rerun required checks against current target head.

A stale candidate cannot rely solely on earlier evidence if relevant base code changed.

## 31.3 Conflict resolution

Merge-conflict workers may propose a resolution candidate, but it must pass the same evidence gates.

---

# 32. Event Types

Minimum event taxonomy:

```text
work_item.created
work_item.updated
plan.created
plan.revised
task.created
task.ready
task.started
task.completed
task.blocked
agent.started
agent.completed
agent.failed
candidate.created
candidate.changed
candidate.rejected
candidate.promoted
hypothesis.created
hypothesis.rejected
fact.verified
decision.proposed
decision.accepted
finding.created
finding.resolved
evidence.recorded
verification.started
verification.completed
review.started
review.completed
artifact.created
budget.warning
budget.exhausted
merge.requested
merge.completed
```

Events power both resume logic and dashboard telemetry.

---

# 33. State Machine

Work item:

```text
DEFINED
  -> PLANNING
  -> READY
  -> EXECUTING
  -> VERIFYING
  -> REVIEWING
  -> INTEGRATING
  -> COMPLETED
```

Possible terminal/intermediate states:

```text
BLOCKED
FAILED
CANCELLED
NEEDS_HUMAN
BUDGET_EXHAUSTED
```

Candidate:

```text
CREATED
 -> IMPLEMENTING
 -> VERIFYING
 -> ELIGIBLE
 -> REVIEWING
 -> PROMOTED

or

 -> REJECTED
```

---

# 34. No-Progress and Failure Guards

Detect:

- same task being regenerated repeatedly;
- semantically equivalent candidate diffs;
- repeated same failure signature;
- same hypothesis recycled without evidence;
- token-limit loops;
- tool-call loops;
- worker repeatedly reading same artifacts;
- reviewer finding churn without severity improvement.

Escalation order:

```text
1. compact context
2. fresh worker
3. clean-room challenger
4. different model family
5. alternative plan
6. specialist review
7. human/block
```

---

# 35. Observability, Pi UI, and Optional CI Dashboard

The dashboard SHOULD expose:

## Work item overview

- spec;
- task DAG;
- current state;
- budgets;
- elapsed time;
- active workers.

## Agent view

- role;
- model route;
- node/provider;
- context tokens;
- output tokens;
- duration;
- tools used;
- candidate produced;
- outcome.

## Candidate tree

Interactive lineage graph showing:

- parent/child candidates;
- rejected reasons;
- current incumbent;
- evidence status;
- reviewer findings.

## Verification view

- running test stages;
- historical runs;
- failures;
- logs on demand;
- coverage/performance deltas.

## Ledger view

- requirements;
- decisions;
- facts;
- hypotheses;
- findings;
- evidence links;
- history.

## Cost/resource view

- tokens by role;
- tokens by model;
- wall-clock time;
- GPU time;
- provider spend;
- context sizes;
- cache usage;
- parallelism utilization.

## CI history

Preserve:

- past builds;
- current builds;
- Pi reviews;
- test output;
- changelogs;
- evolving generated project specification.

---

# 36. Metrics

Track at minimum:

## Quality

- merge acceptance rate;
- escaped defect rate;
- candidate rejection causes;
- reviewer finding severity;
- rollback rate;
- test mutation score where available.

## Agent performance

- success by role/model;
- success by task type;
- attempts per successful task;
- clean-room challenger win rate;
- candidate tournament win rate;
- review false-positive rate.

## Context efficiency

- average input tokens per role;
- 50/90/99th percentile context size;
- retrieved tokens vs total repository size;
- context expansions per task;
- compaction frequency;
- handoff frequency.

## Compute

- aggregate tokens;
- wall-clock duration;
- concurrency;
- GPU utilization;
- provider cost;
- queue wait.

## Verification

- targeted tests selected;
- test-impact precision;
- generated tests retained;
- generated tests finding real defects;
- fuzz discoveries;
- performance regressions caught.

---

# 37. Learning From History Without Training

Version 1 can improve routing deterministically using historical telemetry.

Examples:

```text
Qwen-family implementation success on Go routing = 84%
Model X architecture-review severe-finding precision = 72%
Clean-room challengers beat incumbent on concurrency work = 19%
```

The scheduler may use these metrics as priors without training a new model.

Later versions may train routing/ranking models, but every learned decision should remain overridable by policy.

---

# 38. API Sketch

## Create work item

```http
POST /v1/work-items
```

```json
{
  "spec_ref": "git://autospec/docs/specs/routing.md",
  "repositories": [
    {"repo": "inferweave/gateway", "ref": "main"}
  ],
  "policy": "default-high"
}
```

## Work item status

```http
GET /v1/work-items/{id}
```

## DAG

```http
GET /v1/work-items/{id}/tasks
```

## Ledger query

```http
GET /v1/work-items/{id}/ledger?type=finding&status=open
```

## Candidate

```http
GET /v1/candidates/{id}
```

## Evidence

```http
GET /v1/candidates/{id}/evidence
```

## Artifact

```http
GET /v1/artifacts/{id}
```

## Events

```http
GET /v1/work-items/{id}/events
```

Use SSE/WebSocket for live dashboard updates.

---

# 39. Suggested Storage

Version 1:

- PostgreSQL or SQLite for ledger/materialized state depending on deployment size;
- filesystem/object store for artifacts;
- git for code candidate history;
- optional embeddings/index database for repository retrieval.

Recommended development setup:

```text
SQLite + local artifact directory + git worktrees
```

Production/team setup:

```text
PostgreSQL + S3-compatible artifact store + worker-local worktrees
```

Do not require a vector database for correctness.

---

# 40. Repository Index Lifecycle

The Context Broker maintains an index tied to commit SHA.

```yaml
repo: inferweave/gateway
sha: abc123
index_version: 8
languages:
  - go
lsp_status: ready
ast_status: ready
coverage_map: available
```

Incremental reindexing should process changed files only.

Candidate worktrees may apply an overlay index on top of base commit state.

---

# 41. Prompt Design

Role prompts MUST be intentionally short.

Example implementer system guidance:

```text
You are an implementation worker. Complete only the assigned task.
Use repository tools rather than guessing APIs or signatures.
Treat ledger hypotheses as unverified unless evidence says otherwise.
Do not broaden scope unless required to satisfy an explicit invariant.
Run targeted checks before reporting completion.
Your code is a candidate; do not claim merge approval.
Return only the requested structured result.
```

Avoid putting the entire software engineering handbook into every prompt.

Detailed language/framework guidance lives in on-demand Pi skills.

---

# 42. Skill Progressive Disclosure

The base worker knows only compact skill descriptions.

Load full skills only when needed:

```text
go-engineering
scala-engineering
react-ui
postgres-migrations
security-review
property-testing
performance-benchmarking
api-compatibility
```

A Go backend worker should not carry React UI conventions.

---

# 43. Implementation Roadmap

The roadmap is standalone-first and intentionally parallelizable.

## Phase 0 — Package skeleton and contracts

Create the Pi package, core TypeScript interfaces, schemas, ADRs, and test harness. Define dependency rules that prohibit core imports from AutoSpec/InferWeave adapters.

**Exit:** `pi-engineering` can be installed into a test project using standard Pi package mechanisms.

## Phase 1 — Interactive vertical slice

Implement concurrently:

### Track A — Lightweight ledger

- session/work-item identity;
- immutable events;
- facts/hypotheses/decisions/findings;
- compact `/ledger` view.

### Track B — Fresh Pi worker runtime

- fresh session per delegated role;
- role prompts;
- structured output;
- timeout/token metrics;
- single-model operation.

### Track C — Candidate isolation

- optional worktree creation;
- diff capture;
- candidate lineage;
- cleanup/recovery.

### Track D — Verification runner

- build/test command discovery;
- command stages;
- lazy log artifacts;
- compact pass/fail evidence.

**Integration milestone:** in a normal repository, `pi` can receive a coding request, create an isolated candidate when warranted, run deterministic verification, ask a fresh reviewer, and present evidence without AutoSpec or InferWeave.

## Phase 2 — Context Broker

Implement repository maps, symbols, references, LSP, history, impacted tests, lazy artifact reads, and token-budgeted context assembly.

**Exit:** workers no longer need bulk repository prompt injection.

## Phase 3 — Adaptive risk orchestration

Implement task classification and policies for low/medium/high/critical changes. Ensure trivial edits remain fast and do not spawn unnecessary workers.

## Phase 4 — Clean-room review and challenge

Implement `/review`, `/challenge`, context firewalls, test-design independence, and finding lifecycle.

## Phase 5 — Parallel DAG and scheduler

Implement dependencies, ready queue, scope/conflict prediction, parallel dispatch, dynamic task creation, and no-progress detection. This phase is useful locally with multiple endpoints and is the basis for AutoSpec scale-out.

## Phase 6 — Candidate tournament

Implement multi-candidate policies, objective ranking, comparative review, and promotion transactions.

## Phase 7 — Advanced verification

Parallel tracks: property testing, fuzzing, mutation testing, performance, security, and UI/browser automation.

## Phase 8 — AutoSpec adapter

Map Spec -> Define -> Plan -> Implement -> Verify work items onto the Pi Engineering APIs. Add multi-repository persistence, issue metadata, merge queues, and CI integration without duplicating core functionality.

## Phase 9 — InferWeave adapter

Add capability requests, availability/quota handling, locality, concurrency, model diversity, fallback, and distributed telemetry.

## Phase 10 — Dashboard and historical optimization

Visualize DAGs, agents, candidates, evidence, ledger, context/tokens, and CI history; use telemetry to tune routing, candidate counts, verification depth, task sizing, and context budgets.

---

# 44. Initial GitHub Issue Breakdown

The following issues SHOULD be created for the standalone Pi Engineering project. AutoSpec Define MAY generate or synchronize them after the core repository exists.

## Epic A — Package and core orchestration

- A0 Create standard Pi package skeleton and project-local install fixture.
- A0.1 Add import/dependency checks preventing core -> AutoSpec/InferWeave coupling.

## Epic A.1 — Core orchestration

- A1 Define canonical schemas.
- A2 Implement event store.
- A3 Implement materialized work-item state.
- A4 Implement orchestration state machine.
- A5 Add budget manager.

A1 blocks A2/A3/A4. A5 can begin after A1.

## Epic B — Pi runtime

- B1 Implement Pi RPC client.
- B2 Implement role configuration.
- B3 Implement structured result parser.
- B4 Implement tool allowlist profiles.
- B5 Implement custom compaction/handoff extension.

B1/B2 can run concurrently after interface definition.

## Epic C — Candidate isolation

- C1 Worktree manager.
- C2 Candidate schema/lineage.
- C3 Diff/artifact capture.
- C4 Candidate cleanup/recovery.

## Epic D — Verification

- D1 Verification profile format.
- D2 Command runner sandbox.
- D3 Log/artifact summarization.
- D4 Test impact API.
- D5 Evidence schema.

## Epic E — Context Broker

- E1 Repository file/symbol index.
- E2 LSP adapter.
- E3 Git/history adapter.
- E4 Test/coverage mapping.
- E5 Token-budgeted context assembly.
- E6 Pi context tools.

## Epic F — Scheduler

- F1 Task DAG persistence.
- F2 readiness calculation.
- F3 conflict model.
- F4 parallel dispatcher.
- F5 dynamic DAG updates.
- F6 no-progress guard.

## Epic G — Tournament

- G1 multi-candidate policy.
- G2 clean-room worker profile.
- G3 objective eligibility gates.
- G4 candidate scoring.
- G5 independent comparative review.
- G6 promotion transaction.

## Epic H — Test intelligence

- H1 test-obligation schema.
- H2 test-designer role.
- H3 adversarial test role.
- H4 property test integration.
- H5 fuzz integration.
- H6 mutation integration.

## Epic I — AutoSpec adapter

- I1 map AutoSpec work items/tasks to Pi Engineering schemas.
- I2 map dependency/concurrency metadata.
- I3 multi-repository persistence adapter.
- I4 merge/CI handoff.
- I5 adoption of interactive-session ledger state.

## Epic J — InferWeave

- J1 capability request schema.
- J2 routing adapter.
- J3 availability/quota handling.
- J4 role-separation policy.
- J5 usage telemetry.

## Epic K — Dashboard

- K1 event stream.
- K2 DAG UI.
- K3 agent/run UI.
- K4 candidate tree UI.
- K5 evidence/log UI.
- K6 ledger UI.
- K7 token/resource UI.

Many epics can proceed in parallel after the schemas/interfaces are established.

---

# 45. Acceptance Criteria

## AC-001 Fresh contexts

A multi-stage work item can complete with every task worker starting from a new Pi session while preserving correct state through ledger/context artifacts.

## AC-002 Small footprint

For benchmark repository tasks, median implementation-worker input context is <= 25k tokens unless explicitly escalated.

## AC-003 No incumbent overwrite

A failing candidate cannot alter the incumbent code state.

## AC-004 Candidate lineage

Every promoted candidate has a complete parent chain and captured diff.

## AC-005 Deterministic verification

The system rejects a candidate whose worker claims success but whose required test command fails.

## AC-006 Clean-room independence

A clean-room worker prompt contains no prior worker reasoning, candidate rationale, or unverified notes.

## AC-007 Parallel DAG

At least three nonconflicting ready tasks can be dispatched concurrently and integrated later.

## AC-008 Conflict prevention

Two tasks with a declared incompatible write scope are not dispatched concurrently into the same integration chain.

## AC-009 Reviewer separation

Review policy prevents the implementation run from being used as its own independent approval.

## AC-010 Artifact laziness

Large test/build output remains in artifact storage and only compact summaries enter model context by default.

## AC-011 Resume

Killing and restarting the orchestrator during execution reconstructs work-item state from the event store and safely resumes/marks orphaned jobs.

## AC-012 Budget enforcement

A task exceeding configured agent/token/time budgets terminates or escalates according to policy.

## AC-013 Evidence traceability

Every promotion can show which required evidence gates passed and which reviewer approved it.

## AC-014 Context broker

A worker can retrieve definitions/references/tests without full-file or full-repository prompt injection.

## AC-015 Generated tests

High-risk profile can generate independent test obligations and execute accepted generated tests against candidates.

## AC-016 InferWeave optionality

The same orchestration workflow works with static direct models when InferWeave is disabled.

## AC-017 Standalone Pi installation

A user can install Pi Engineering using standard Pi package mechanisms in a repository with no AutoSpec service and complete a verified coding task.

## AC-018 Single-model operation

With only one model configured, the runtime can execute scout/implement/review phases as separate fresh sessions with context isolation.

## AC-019 Risk proportionality

A trivial text/UI-label edit does not spawn a candidate tournament or full verification farm by default.

## AC-020 AutoSpec adapter isolation

Removing the AutoSpec adapter does not break ledger, context, worker, candidate, verification, handoff, or review functionality.

## AC-021 Interactive commands

`/review`, `/challenge`, `/verify`, `/handoff`, and `/context` operate in a standard Pi session without AutoSpec.

---

# 46. Benchmark and Evaluation Plan

Evaluate Pi Engineering first against ordinary Pi sessions, then against existing AutoSpec implementation flows on a representative task set.

Include:

- small bug fixes;
- medium feature changes;
- cross-module changes;
- concurrency/routing changes;
- API migrations;
- UI work;
- test-only work;
- multi-repository changes.

Measure:

```text
success rate
human rework
escaped failures
wall-clock time
aggregate tokens
median worker context
gpu-hours
cloud cost
candidate count
review findings
test failures caught before merge
```

A/B modes:

```text
A: standard Pi baseline
B: Pi Engineering ledger + fresh workers
C: B + context broker + verification
D: C + clean-room review
E: D + candidate tournament
F: AutoSpec + Pi Engineering on project-scale tasks
```

This lets us determine where extra inference compute buys actual engineering quality.

---

# 47. GVS5H Mapping

This project borrows the useful scaffold ideas while intentionally changing the parts that do not fit repository-scale engineering.

| GVS5H | Pi Engineering design |
|---|---|
| `task.md` | typed work item + requirements |
| `plan.md` | versioned implementation plan |
| `tasks.json` | dependency-aware task DAG |
| `notes.md` | typed Engineering Ledger |
| `solution.py` | immutable candidate tree + incumbent |
| one fresh worker | many role-specialized fresh Pi workers |
| same model all roles | capability routing + separation of duties |
| one next task | parallel ready-task scheduler |
| sample tests | verification farm |
| worker rewrites solution | isolated worktree candidate |
| inherited notes | filtered informed context + clean-room option |
| manager says done | deterministic gates + independent approval |
| max iteration count | multidimensional budget manager |
| transcript JSONL | event store + artifacts + telemetry |

This is a conceptual extension, not a source-code fork of GVS5H. AutoSpec consumes the resulting Pi Engineering primitives when installed.

---

# 48. Failure Modes and Mitigations

## FM-001 Anchoring on incorrect early theory

**Mitigation:** clean-room challengers, typed hypotheses, evidence promotion.

## FM-002 Correct incumbent degraded by later rewrite

**Mitigation:** immutable incumbent, candidate isolation, promotion gates.

## FM-003 Agents parrot each other

**Mitigation:** context firewall, model diversity, clean-room roles.

## FM-004 Reviewer invents issues to satisfy prompt

**Mitigation:** explicitly allow “no material finding”; require concrete evidence and severity.

## FM-005 Excessive token use from logs

**Mitigation:** artifact references + lazy expansion.

## FM-006 Tool-schema bloat

**Mitigation:** role-specific allowlists.

## FM-007 Agent loops

**Mitigation:** bounded run, repeated-action detection, no-progress guard.

## FM-008 Too many candidates overload CI

**Mitigation:** staged gates, backpressure, marginal-value stop.

## FM-009 Incorrect ledger claim becomes permanent truth

**Mitigation:** typed trust levels and explicit promotion.

## FM-010 Parallel agents create merge chaos

**Mitigation:** write-scope prediction, dependency DAG, candidate branches, integration queue.

## FM-011 Generated tests encode implementation instead of requirement

**Mitigation:** independent test design from requirements/invariants; review generated tests.

## FM-012 Small tasks become over-engineered

**Mitigation:** risk-adaptive profiles.

---

# 49. Default Policies

## Default implementation context

```yaml
target_tokens: 16000
hard_max_tokens: 40000
retrieve_incrementally: true
include_raw_transcript: false
```

## Default medium-risk orchestration

```yaml
implementers: 1
clean_room_challengers: 0
test_designer: 1
reviewers: 1
verification: impacted
```

## Default high-risk orchestration

```yaml
implementers: 2
clean_room_challengers: 1
test_designer: 1
adversarial_testers: 1
reviewers: 1
specialists: auto
verification: full_relevant
```

## Candidate promotion

```yaml
require_hard_gates: true
require_independent_review: medium_and_above
allow_worker_self_approval: false
prefer_minimal_semantic_change_on_tie: true
```

---

# 50. Example End-to-End Run

This example starts as an ordinary Pi coding request. If AutoSpec metadata exists, the same state can later be adopted into a formal work item.

User request:

```text
Preserve InferWeave session affinity across provider failure and reconnect.
```

## Step 1 — Session engineering state

Pi Engineering extracts/records:

```text
REQ-1 preserve session identity
REQ-2 fallback if provider unavailable
INV-1 no inbound dependency introduced
INV-2 existing API compatibility
```

## Step 2 — Plan

Planner creates:

```text
T1 inspect route/retry ownership
T2 design state transition
T3 define test obligations
T4 implement routing change
T5 implement tests
T6 integration verification
```

Dependencies:

```text
T1 -> T2 -> T4 -> T6
          \-> T5 -> T6
T3 ---------> T5
```

T1 and T3 run concurrently.

## Step 3 — Context

T1 receives only relevant route/session symbols and existing affinity invariants.

T3 receives requirements, existing tests, API surfaces, but not implementation reasoning.

## Step 4 — Candidates

High-risk profile generates:

```text
C1 informed Qwen implementer
C2 second informed candidate
C3 clean-room alternative
```

Each runs in a distinct worktree.

## Step 5 — Verification

C1 fails race test.

C2 passes unit/integration but introduces public API change.

C3 passes all gates.

Only C3 proceeds.

## Step 6 — Review

Independent reviewer sees:

- requirements;
- invariants;
- C3 diff;
- impacted code;
- evidence summaries.

It does not see C3’s implementation transcript.

## Step 7 — Promotion

C3 becomes integration candidate, rebases on target, reruns affected checks, then enters merge queue.

All rejected candidates remain inspectable in telemetry.

---

# 51. Suggested First Prototype

Do not start with AutoSpec integration, distributed scheduling, or a dashboard.

The first prototype MUST prove value in an ordinary Pi installation:

```text
normal Git repository
 -> install pi-engineering package
 -> start `pi`
 -> user asks for a medium-risk code change
 -> lightweight repo discovery
 -> fresh scout (optional by policy)
 -> isolated candidate worktree
 -> deterministic targeted build/test
 -> fresh independent reviewer
 -> promote/reject candidate
 -> compact ledger/evidence visible in session
```

Success means the user experiences this as normal Pi coding rather than operating an orchestration product.

The second prototype adds Context Broker retrieval and `/challenge`.

The third adds parallel candidates and a small tournament when more than one endpoint is available.

Only after those are stable should AutoSpec and InferWeave adapters become required integration milestones.

---

# 52. Implementation Guidance for Pi Engineering and AutoSpec Define

For the standalone project, implement the Pi Engineering core first. When this spec is later given to `autospec-define`, it SHOULD:

1. parse all MUST/SHOULD requirements;
2. generate ADR questions only where repository inspection cannot resolve the choice;
3. inspect existing Pi packages and existing AutoSpec orchestration code before creating new components;
4. map new concepts onto existing packages where possible;
5. avoid duplicating existing Pi routing, CI, or issue-DAG functionality;
6. create GitHub issues organized by the epics above;
7. mark concurrency/dependency metadata explicitly;
8. create acceptance tests for core invariants;
9. implement the vertical slice before advanced verification features;
10. update README/architecture docs alongside code;
11. keep AutoSpec-specific code inside the adapter boundary;
12. prove standard Pi installation and single-model operation in CI.

AutoSpec Define MUST NOT interpret this specification as a requirement to rewrite functioning orchestration unnecessarily.

---

# 53. Initial Implementation Prompt

Use the following prompt after this specification is checked into the new Pi Engineering repository:

```text
Implement the specification at:
<PATH-TO-SPEC>

Build the standalone Pi Engineering core first. Do not make AutoSpec or InferWeave a dependency of the core package.

Start by inspecting the current Pi extension/package/SDK/RPC interfaces and the repository itself. Reuse existing Pi mechanisms rather than forking Pi core.

First milestone:
- standard Pi package installation;
- ordinary interactive Pi session;
- fresh-context delegated worker;
- lightweight Engineering Ledger;
- isolated candidate worktree when appropriate;
- deterministic targeted verification;
- fresh independent review;
- promote/reject with captured evidence;
- lazy storage of large command output.

Requirements:
- The package must be useful with one model endpoint.
- Multi-model diversity is an optimization, not a requirement.
- AutoSpec and InferWeave must be optional adapters.
- Use progressive-disclosure Skills rather than a giant permanent prompt.
- Use role-specific tool schemas.
- Every delegated worker is fresh-context by default.
- Do not overwrite a known-good incumbent with unverified output.
- Agent claims are never accepted as verification evidence without captured tool results.
- Low-risk edits must remain fast and must not automatically trigger heavyweight orchestration.
- Implement `/review`, `/challenge`, `/verify`, `/handoff`, `/ledger`, and `/context` as the first explicit commands after the vertical slice.
- Preserve interfaces needed for future AutoSpec task-DAG orchestration and InferWeave capability routing.
- Add tests proving the core invariants and standalone operation.

Before implementing, produce:
1. current Pi capability inventory;
2. package architecture and dependency boundaries;
3. repository capability-discovery design;
4. vertical-slice issue DAG with concurrency metadata;
5. test plan for standalone/single-model operation.

Then implement the vertical slice. Add Context Broker and adaptive risk orchestration next. Do not begin AutoSpec/InferWeave integration until standalone acceptance criteria pass.
```

For an existing AutoSpec repository, the adapter implementation SHOULD consume this runtime rather than copy its internals.

---

# 54. References

The design was informed by the following public sources and concepts.

1. GVS5H repository — ledger-based fresh-context manager/worker implementation:  
   https://github.com/slee-persis/GVS5H

2. Gao et al., “Zero-Shot Self-Orchestration with Ledger-Based Control for Improved LLM Coding Performance,” arXiv:2608.26480v1, 27 Aug 2026:  
   https://arxiv.org/abs/2608.26480

3. Pi coding-agent SDK documentation — programmatic sessions, custom resource loading, agent/tool integration:  
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md

4. Pi RPC documentation — headless JSON protocol, compaction controls, subprocess integration:  
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md

5. Pi extension documentation — custom tools, lifecycle interception, subagents, session integration, compaction, and custom UI:  
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

6. Pi package documentation — distribution of extensions, skills, prompts, and themes through npm/git:  
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md

7. Pi skills documentation — progressive disclosure with name/description resident and full skill loaded on demand:  
   https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md

---

# 55. Final Architecture Principle

Pi Engineering should behave as though it has enormous memory and repository understanding while exposing only a small, relevant working set to any individual model invocation. This must be true in a one-user interactive Pi session as well as under AutoSpec orchestration.

The project therefore adopts the following final principles:

> **No agent receives information merely because it exists. It receives information because the current task requires it. No candidate is trusted because an agent believes it works. It is promoted because independent evidence demonstrates that it satisfies the required engineering constraints.**
>
> **Pi Engineering is independently useful. AutoSpec adds structured project orchestration; InferWeave adds compute orchestration. Neither is required for the engineering runtime itself.**

