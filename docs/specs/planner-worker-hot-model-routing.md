# Specification: Planner/Worker Execution + InferWeave Hot Model Routing

## Goal

Extend `berlinguyinca/pi-engineering` and `inferweave/inferweave` so engineering missions can dynamically use different models for different cognitive roles.

Primary local configuration:

- **Qwen Flash / Flash-Next** → planning, investigation, decomposition, debugging, review
- **Qwen 27B** → implementation, tests, mechanical fixes
- **Claude/Codex/frontier models** → escalation only when local execution repeatedly fails

Both Qwen models are normally resident in InferWeave, so switching roles should be cheap.

The architecture MUST NOT hard-code these specific model names. Roles resolve through InferWeave capabilities/aliases so better models can replace them later.

---

# 1. Architectural Boundary

Keep responsibilities clean.

## pi-engineering owns

- planner/worker/reviewer workflow
- task decomposition
- task contracts
- deciding when review is required
- deciding when another implementation attempt is appropriate
- deciding when escalation is required
- maintaining mission state
- worktrees
- verification
- commits
- convergence detection

## InferWeave owns

- available models
- model aliases
- model capabilities
- routing
- capacity
- slots
- health
- model loading/unloading
- hot model replacement
- fallback candidates
- runtime lifecycle

InferWeave MUST NOT learn concepts such as:

- planner
- coder
- reviewer
- pi-engineering mission

Those are application-level concepts.

Pi requests capabilities; InferWeave supplies appropriate inference.

---

# 2. Planner/Worker Execution Mode

Add a first-class execution mode:

`planner-worker`

Conceptual loop:

```text
Mission
   ↓
Planner
   ↓
Task DAG
   ↓
┌──────────────┐
│ Task Contract│
└──────┬───────┘
       ↓
    Worker
       ↓
 tests / validation
       ↓
    Reviewer
       ↓
 ┌─────┴──────┐
PASS         FIX
 │             │
next task   Worker
 │             │
 └──────┬──────┘
        ↓
   Final Review
```

Default role mapping:

```yaml
roles:
  planner:
    capability: coding.planning
    preferred_family: qwen-flash

  researcher:
    capability: coding.analysis
    preferred_family: qwen-flash

  implementer:
    capability: coding.implementation
    preferred_family: qwen-27b

  reviewer:
    capability: coding.review
    preferred_family: qwen-flash

  debugger:
    capability: coding.debugging
    preferred_family: qwen-flash

  fixer:
    capability: coding.implementation
    preferred_family: qwen-27b
```

These are preferences, NOT fixed model IDs.

---

# 3. Structured Task Contracts

The planner MUST convert the mission into bounded implementation contracts.

Example:

```yaml
task_id: auth-003

objective:
  Implement refresh-token rotation.

depends_on:
  - auth-001
  - auth-002

scope:
  allowed:
    - src/auth/**
    - tests/auth/**

acceptance:
  - refresh tokens are validated
  - expired tokens are rejected
  - successful refresh rotates token
  - login behavior remains unchanged

verification:
  - cargo test auth
  - cargo clippy

constraints:
  - do not redesign authentication
  - do not modify unrelated packages
  - do not change unrelated public APIs
```

The worker receives:

1. mission summary
2. relevant architectural context
3. task contract
4. relevant files
5. results from dependencies

It SHOULD NOT receive the entire planner reasoning transcript.

The worker instruction should explicitly state:

> Implement the supplied contract. Do not redesign or re-plan the overall mission unless the contract is impossible or contradictory.

This keeps 27B focused on implementation rather than burning context repeatedly reconsidering architecture.

---

# 4. Task DAG

Flash should produce a DAG rather than a flat todo list.

Example:

```text
          ┌── database ───┐
planning ─┤               ├── integration ── final review
          ├── API ────────┤
          └── tests ──────┘
```

Independent tasks MAY execute concurrently using existing pi-engineering worker/worktree infrastructure.

Each task tracks:

```text
pending
ready
running
reviewing
needs_fix
blocked
passed
failed
escalated
```

---

# 5. Review Loop

After implementation:

```text
27B implementation
       ↓
automated verification
       ↓
Flash review
```

Reviewer receives:

- contract
- diff
- test results
- relevant surrounding code
- worker summary

It should NOT redo the entire original planning process.

Review response should be structured:

```yaml
status: pass | needs_fix | replan | escalate

issues:
  - ...

required_changes:
  - ...

contract_violation:
  true | false
```

---

# 6. Correction Loop

If review returns `needs_fix`:

```text
Flash
  ↓
small correction contract
  ↓
27B
  ↓
tests
  ↓
Flash
```

Do NOT simply tell the worker:

> Fix the review comments.

Generate another bounded contract.

This prevents correction loops from expanding uncontrollably.

---

# 7. Replanning

If implementation discovers that the original contract is impossible:

```text
Worker
  ↓
BLOCKED + evidence
  ↓
Flash planner
  ↓
update DAG
  ↓
new contracts
```

Worker must not silently redesign the mission.

---

# 8. Escalation

Local execution should be attempted first.

Default ladder:

```text
Flash plan
   ↓
27B implementation
   ↓
Flash review
   ↓
27B correction
   ↓
Flash review
```

After configurable repeated failures:

```text
Flash diagnosis
       ↓
27B retry
       ↓
frontier escalation
```

Potential escalation targets:

- Codex
- Claude
- other configured high-capability models

Existing pi-engineering policy remains:

**Planning and implementation SHOULD NOT be performed by the same model whenever alternatives are available.**

---

# 9. InferWeave Logical Model Requests

Pi should stop depending on exact model IDs wherever possible.

Instead of:

```text
model=qwen3.8-27b-q8
```

allow requests such as:

```text
alias=coding-implementation
```

or capability constraints:

```yaml
capabilities:
  - coding
  - tool_use

minimum_context: 128000

preferences:
  family: qwen
  size_class: medium
```

InferWeave resolves this against currently available runtimes.

---

# 10. InferWeave Hot Model Routing

Add explicit support for changing the model backing a logical route without restarting clients.

Example:

```text
coding-implementation
        │
        ▼
Qwen 27B
```

may become:

```text
coding-implementation
        │
        ▼
Qwen 32B successor
```

Pi continues using the same logical route.

No Pi restart should be required.

---

# 11. Hot Swap Semantics

Hot swapping MUST occur at inference boundaries.

Never migrate a partially generated response between models.

Safe boundary:

```text
request N
   ↓
Qwen 27B
   ↓
complete

ROUTE CHANGES

request N+1
   ↓
replacement model
```

Streaming responses already underway remain pinned to their selected runtime.

---

# 12. Session Continuity

Model switching must preserve:

- conversation messages
- tool calls/results
- mission state
- task contract
- worktree
- file state
- summaries
- verification history

Pi already supports mid-session model switching and cross-provider handoffs, so pi-engineering SHOULD integrate with those mechanisms rather than creating an incompatible second session format.

Every model transition should become an explicit event:

```text
MODEL_TRANSITION

from: qwen-flash
to: qwen-27b
reason: implementation
task: auth-003
```

---

# 13. InferWeave Runtime Hot Loading

Separate two concepts:

## Route hot swap

Change which already-loaded model receives future requests.

Expected latency: effectively immediate.

## Runtime hot swap

Required model isn't loaded.

InferWeave:

```text
request
   ↓
resolve capability
   ↓
no suitable loaded runtime
   ↓
find capacity
   ↓
load model
   ↓
health probe
   ↓
advertise ready
   ↓
route request
```

This integrates with InferWeave's existing scheduling/autoscaling model.

---

# 14. Graceful Runtime Replacement

When replacing a model:

```text
OLD MODEL
   ↓
mark DRAINING
   ↓
stop accepting new work
   ↓
finish active requests
   ↓
unload
```

Meanwhile:

```text
NEW MODEL
   ↓
load
   ↓
probe
   ↓
READY
   ↓
new requests
```

When capacity permits, prefer:

**load → verify → switch → drain old**

rather than:

**unload → load**

This minimizes service interruption.

---

# 15. Capacity-Aware Role Resolution

Pi may request:

```text
coding.planning
```

InferWeave could have:

```text
Flash-A    busy
Flash-B    available
27B-A      available
Claude     external
```

InferWeave selects Flash-B.

Pi doesn't care which physical runtime handled it.

This is important for multi-node deployments.

---

# 16. Failure-Aware Switching

If InferWeave reports:

```text
NO_WORKERS
MODEL_UNAVAILABLE
MODEL_LOADING
CAPACITY_EXHAUSTED
NODE_DRAINING
NODE_LOST
```

pi-engineering should consume the InferWeave protocol metadata already being added elsewhere.

Example:

```text
27B unavailable
      ↓
InferWeave reports candidates
      ↓
Pi evaluates task requirements
      ↓
comparable implementation model
```

Do NOT blindly retry an unavailable model forever.

---

# 17. Context Compatibility

Before switching models, validate:

- target context capacity
- modality support
- tool support
- structured-output support
- required capabilities

If current context is:

```text
91k tokens
```

a 64k model cannot simply replace a 128k model.

Options:

1. choose another compatible model
2. compact context
3. create task-specific handoff context
4. reject transition

For planner → worker transitions, prefer task-specific handoff context rather than carrying the complete planner context.

---

# 18. Model Handoff Artifact

Every role transition should create a compact handoff.

Example:

```yaml
handoff:
  mission_id: M123
  task_id: auth-003

  from_role: planner
  to_role: implementer

  objective:
    Implement refresh-token rotation.

  relevant_files:
    - src/auth/token.rs
    - src/auth/routes.rs

  decisions:
    - reuse existing JWT abstraction

  constraints:
    - no schema changes

  acceptance:
    - ...

  verification:
    - ...
```

This becomes the stable interface between agents.

---

# 19. Parallel Execution

Flash can identify independent work:

```text
                Flash
                  │
          ┌───────┼───────┐
          ▼       ▼       ▼
        27B-A   27B-B   27B-C
          │       │       │
          └───────┼───────┘
                  ▼
                Flash
```

Each worker gets:

- isolated worktree
- independent contract
- bounded context

Existing pi-engineering concurrency controls still apply.

---

# 20. Dynamic Review Frequency

Do not review every trivial operation.

Planner should assign risk:

```yaml
risk: low | medium | high
```

Suggested policy:

```text
low
→ implement
→ tests
→ batch review

medium
→ implement
→ tests
→ review

high
→ pre-implementation review
→ implement
→ tests
→ immediate review
```

Examples of high-risk changes:

- migrations
- authentication
- concurrency
- distributed state
- protocol changes
- destructive operations
- large refactors

---

# 21. Convergence Detection

Prevent endless:

```text
Flash → 27B → Flash → 27B → ...
```

Track:

- attempts
- repeated findings
- identical failures
- test progress
- diff churn
- files repeatedly rewritten
- contract changes

If no measurable progress occurs after configurable attempts:

```text
LOCAL_LOOP_STALLED
```

Trigger deeper diagnosis or escalation.

---

# 22. Observability

pi-engineering UI/status should expose:

```text
Mission: InferWeave routing overhaul

Planner:
  Flash
  complete

Workers:
  task-01 → 27B → running
  task-02 → 27B → tests
  task-03 → waiting

Reviewer:
  Flash
  idle

Local attempts: 4
Escalations: 0
```

Record per role/model:

- prompt tokens
- completion tokens
- cached tokens
- wall time
- tool calls
- retries
- failures
- review failures
- accepted tasks
- rejected tasks
- escalations

This lets us benchmark whether planner/worker actually improves engineering performance.

---

# 23. InferWeave Telemetry

InferWeave should expose model transitions:

```text
MODEL_ROUTE_RESOLVED
MODEL_LOADING
MODEL_READY
MODEL_DRAINING
MODEL_UNLOADED
MODEL_ROUTE_CHANGED
MODEL_UNAVAILABLE
MODEL_FALLBACK
```

Upstream gateways can visualize these using the InferWeave protocol.

---

# 24. Benchmarking

Extend the pi-engineering benchmark suite.

Compare:

### A

```text
27B alone
```

### B

```text
Flash alone
```

### C

```text
Flash plan
27B implement
Flash review
```

### D

```text
Flash plan
parallel 27B workers
Flash review
```

Measure:

- task success
- wall-clock time
- tokens
- tool calls
- test passes
- retries
- regressions
- reviewer findings
- context consumption
- escalation frequency

The important metric is not tokens/sec.

It is:

```text
successful engineering work
---------------------------
GPU time + wall-clock time
```

---

# 25. Automatic Strategy Learning

Collect enough telemetry to eventually answer:

```text
What execution strategy works best
for this type of task?
```

Examples:

```text
small bug
→ 27B directly

architecture change
→ Flash → 27B → Flash

large refactor
→ Flash → parallel 27B → Flash

difficult debugging
→ Flash diagnosis → 27B repair

repeated local failure
→ frontier escalation
```

Do NOT implement autonomous learned routing in the first version.

First collect evidence.

---

# 26. User Controls

Add commands/configuration:

```text
/engineering-mode auto
/engineering-mode planner-worker
/engineering-mode single

/engineering-status
/engineering-plan
/engineering-workers
```

Default:

```text
auto
```

Auto should normally select planner-worker for nontrivial engineering missions.

---

# 27. Important Principle

Models are workers, not missions.

The durable state belongs to pi-engineering:

```text
mission
plan
contracts
DAG
repository
worktrees
tests
review state
history
```

Models should be replaceable at any inference boundary.

Therefore:

```text
Flash disappears
```

must NOT destroy the mission.

Likewise:

```text
27B → newer 30B model
```

should require no architectural change.

---

# 28. Acceptance Criteria

Implementation is complete when:

1. Pi can plan with Flash and implement with 27B automatically.
2. Planner output becomes structured task contracts.
3. Independent contracts can execute concurrently.
4. Flash reviews completed implementation.
5. Failed reviews create bounded correction contracts.
6. Repeated failures trigger escalation.
7. Model changes do not restart the Pi session.
8. InferWeave logical routes can change backing models live.
9. Active streams remain pinned during route changes.
10. InferWeave can gracefully drain and replace runtimes.
11. Pi can react to InferWeave availability/error metadata.
12. Context compatibility is checked before handoff.
13. Every role/model transition is observable.
14. Existing single-model workflows remain supported.
15. Existing OpenAI-compatible clients remain unaffected.

---

# Recommended Implementation Order

**Phase 1 — pi-engineering**

Implement:

`Flash planner → 27B worker → Flash reviewer`

with structured contracts and handoffs.

**Phase 2 — InferWeave**

Implement logical route hot swapping, runtime draining, loading and capability-based replacement.

**Phase 3 — Integration**

Make pi-engineering resolve its roles through InferWeave aliases/capabilities and react to InferWeave lifecycle/error metadata.

**Phase 4 — Parallelism**

Allow the planner to produce DAGs executed by parallel 27B workers/worktrees.

**Phase 5 — Measurement**

Run A/B/C/D benchmark modes and determine empirically when planner-worker execution wins.

---

## Core Design Rule

Do not build:

`Pi → Qwen Flash → Qwen 27B`

as a hard-coded pipeline.

Build:

```text
Pi role
   ↓
capability requirement
   ↓
InferWeave
   ↓
best currently available model/runtime
```

That makes Flash + 27B today's excellent default while allowing the entire system to evolve without redesigning pi-engineering.
