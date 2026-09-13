# Pi Engineering Runtime — Verifiable Roadmap Completion Specification

**Status:** Proposed  
**Target:** Pi Engineering Runtime  
**Primary goal:** Make roadmap completion deterministic, evidence-backed, machine-verifiable, and suitable for autonomous Pi operation.

---

## 1. Problem

Pi Engineering Runtime is intended to operate autonomously for long periods of software-engineering work. A normal prose roadmap is insufficient because:

- milestones can be marked complete without proof;
- implemented code can be confused with verified behavior;
- later changes can silently invalidate earlier verification;
- an autonomous agent may continue inventing work forever;
- operators cannot reliably answer “is Roadmap 1.0 actually finished?”;
- CI cannot enforce roadmap completion;
- roadmap completion can become dependent on model judgment.

The system therefore requires a structured roadmap and evidence model where completion is computed from verifiable predicates rather than declared by an LLM.

## 2. Design Principles

Roadmap completion MUST be a derived state.

An agent MUST NOT be able to make a roadmap complete simply by writing `status: verified`.

Instead, status is computed from:

- milestone acceptance criteria;
- required verification evidence;
- dependency completion;
- unresolved findings;
- dogfood evidence;
- benchmark requirements;
- freshness of evidence;
- release-wide gates.

Core invariants:

> **No evidence = no verification.**

> **Implemented does not mean complete.**

> **A completed roadmap version is finite and must not silently grow forever.**

## 3. Scope

This specification covers:

- structured roadmap format;
- milestone lifecycle;
- acceptance criteria;
- evidence references;
- verification freshness;
- automatic invalidation and reverification;
- dependency handling;
- `/roadmap-status`;
- machine-readable roadmap checking;
- CI integration;
- release completion gates;
- engineering benchmarks;
- autonomy metrics;
- roadmap versioning;
- stopping behavior for autonomous agents.

This specification does NOT require:

- AutoSpec roadmap generation;
- GitHub project boards;
- InferWeave scheduling;
- release publishing;
- hosted dashboards.

These can consume the roadmap API later.

## 4. Roadmap Versioning

Roadmaps MUST be versioned.

Example:

```yaml
roadmap:
  id: pi-engineering-runtime
  version: "1.0"
  codename: standalone-engineering-runtime
```

A roadmap version defines a finite completion boundary.

New ideas MUST NOT silently extend an existing roadmap version after its completion criteria are frozen. Instead create Roadmap 1.1, Roadmap 2.0, backlog items, or optional future milestones.

The system must be able to truthfully state:

> Roadmap 1.0 is complete.

without implying that the project will never change again.

## 5. Roadmap File Layout

Recommended repository layout:

```text
docs/
  roadmap/
    roadmap.yaml
    releases/
      1.0.yaml
    evidence/
      index.yaml

benchmarks/
  engineering-suite/

.pi-engineering/
  evidence/
  artifacts/
  roadmap-cache/
```

`docs/roadmap/roadmap.yaml` is the authoritative human-editable roadmap definition.

Large evidence artifacts MAY live outside Git, but references MUST be stable and resolvable.

## 6. Milestone States

Every milestone MUST resolve to exactly one state:

```text
NOT_STARTED
IN_PROGRESS
IMPLEMENTED
VERIFIED
NEEDS_REVERIFICATION
BLOCKED
DEFERRED
```

### 6.1 NOT_STARTED

No meaningful implementation exists.

### 6.2 IN_PROGRESS

Implementation work has begun but the milestone is incomplete.

### 6.3 IMPLEMENTED

The required implementation appears to exist, but full completion evidence has not been satisfied.

`IMPLEMENTED` MUST NOT count toward roadmap completion.

### 6.4 VERIFIED

All required acceptance criteria and verification gates are satisfied with valid evidence.

Only `VERIFIED` milestones count as completed required work.

### 6.5 NEEDS_REVERIFICATION

The milestone was previously VERIFIED, but relevant changes occurred after its evidence was generated.

This MUST NOT count as complete.

### 6.6 BLOCKED

The milestone cannot currently proceed because of a documented external or technical blocker.

`BLOCKED` MUST NOT count as complete.

### 6.7 DEFERRED

The milestone is intentionally excluded from the current roadmap release scope.

`DEFERRED` counts toward roadmap closure ONLY when:

- the roadmap explicitly allows deferral;
- a reason exists;
- the milestone is not required for this release.

Required milestones MUST NOT be silently deferred.

## 7. Milestone Schema

Example:

```yaml
milestones:
  - id: M07
    name: Candidate Tournament
    required: true

    depends_on:
      - M05
      - M06

    scope:
      paths:
        - src/candidates/**
        - src/worktrees/**
      symbols:
        - CandidateManager
        - TournamentRunner

    acceptance:
      - id: M07-A1
        description: At least two isolated candidates can compete
        evidence:
          required:
            - type: test
              id: candidate-tournament-e2e

      - id: M07-A2
        description: Incumbent candidate cannot be overwritten before promotion
        evidence:
          required:
            - type: test
              id: incumbent-preservation

      - id: M07-A3
        description: Deterministic verification runs before LLM judging
        evidence:
          required:
            - type: test
              id: verification-before-judge

      - id: M07-A4
        description: Losing worktrees are cleaned up safely
        evidence:
          required:
            - type: test
              id: candidate-cleanup

    verification:
      requires:
        - unit
        - integration
        - e2e
        - dogfood
        - fresh_review
```

## 8. Evidence Model

Verification MUST reference evidence.

Example:

```yaml
evidence:
  id: EV-M07-20260912-001
  milestone: M07
  commit: 29de48c
  generated_at: 2026-09-12T18:42:00-07:00

  unit:
    status: pass
    artifact: artifact://tests/unit/8102

  integration:
    status: pass
    artifact: artifact://tests/integration/8103

  e2e:
    status: pass
    artifact: artifact://tests/e2e/1942

  dogfood:
    status: pass
    artifact: artifact://dogfood/441

  fresh_review:
    status: pass
    artifact: artifact://review/992
    unresolved_critical: 0
    unresolved_high: 0
```

Evidence MUST NOT rely solely on narrative model output.

Acceptable evidence includes:

- compiler/type-check result;
- deterministic test run;
- integration test;
- end-to-end test;
- benchmark result;
- dogfood execution;
- static analysis;
- lint result;
- coverage result;
- reproducible runtime assertion;
- fresh-context review with findings recorded;
- signed or hashed external artifact where appropriate.

## 9. Evidence Freshness

Evidence is valid only for the code/configuration it verified.

The runtime MUST associate evidence with at least:

- commit SHA;
- affected paths or components;
- milestone;
- evidence generation timestamp.

If code relevant to a VERIFIED milestone changes afterward, the milestone MUST transition to:

```text
NEEDS_REVERIFICATION
```

unless the runtime can prove the change is unrelated.

A documentation-only change SHOULD NOT invalidate unrelated implementation milestones.

## 10. Impact-Based Invalidation

The runtime SHOULD use dependency and component metadata to avoid revalidating the entire roadmap after every commit.

Milestones MAY specify owned/affected areas using paths and symbols.

Later Context Broker integration MAY improve impact analysis using:

- symbol dependency graph;
- test coverage;
- module dependency graph;
- semantic diff;
- API contract changes.

Conservative invalidation is preferable to false verification.

## 11. Verification Gate

A milestone resolves to VERIFIED only when ALL are true:

1. implementation exists;
2. every required acceptance criterion has valid evidence;
3. required dependencies are VERIFIED;
4. all required test/verification classes pass;
5. required dogfood evidence passes;
6. required independent review has completed;
7. unresolved critical findings = 0;
8. unresolved high findings = 0 unless explicitly waived;
9. evidence is fresh;
10. no required criterion is BLOCKED.

LLM opinion MUST NOT override a failed deterministic gate.

## 12. Fresh Review

Milestones MAY require an independent fresh-context review.

The reviewer MUST NOT inherit implementation reasoning.

It SHOULD receive only:

- relevant acceptance criteria;
- architectural invariants;
- relevant implementation/diff;
- deterministic verification evidence.

The reviewer MUST be permitted to return:

```text
NO_MATERIAL_FINDINGS
```

Review prompts MUST NOT force artificial criticism.

Example evidence:

```yaml
review:
  reviewer_context: fresh
  model: deepseek-v4-flash
  findings:
    critical: 0
    high: 0
    medium: 2
    low: 1
  artifact: artifact://review/992
```

## 13. Roadmap Completion

A roadmap version is complete only when:

```text
all required milestones == VERIFIED
AND
release gate == PASS
```

Optional milestones MAY remain incomplete.

Deferred milestones only count as closed when explicitly non-required.

## 14. Release Gate

Roadmap-level release verification is stricter than individual milestones.

Example:

```yaml
release_gate:
  require:
    all_required_milestones_verified: true

    tests:
      unit: pass
      integration: pass
      e2e: pass

    dogfood:
      standalone_repo: pass
      medium_repo: pass
      large_repo: pass

    benchmark:
      engineering_suite: pass

    autonomy:
      normal_task_question_budget: 0

    context_efficiency:
      pass: true

    fresh_review:
      unresolved_critical: 0
      unresolved_high: 0

    documentation:
      installation: verified
      architecture: current
      commands: current
```

Only if the release gate passes may the runtime report:

```text
ROADMAP_COMPLETE=true
```

## 15. Original Objective Verification

Pi Engineering Runtime was created to improve:

- coding capability;
- software-engineering quality;
- testing quality;
- autonomy;
- context/token efficiency;
- parallel engineering throughput.

Roadmap completion MUST therefore validate outcomes, not merely code presence.

### 15.1 Capability

Track:

- benchmark task success rate;
- deterministic test success;
- escaped defect rate;
- independent review findings;
- regression rate.

### 15.2 Autonomy

Track:

- user questions per task;
- operator interventions;
- autonomous decisions;
- tasks completed without operator interaction;
- true blocker count.

Normal engineering tasks SHOULD target:

```text
questions_per_task = 0
```

### 15.3 Context Efficiency

Track:

- peak parent context;
- average worker context;
- input tokens;
- output tokens;
- tokens per verified change;
- bytes/tokens hidden behind artifact references;
- retrieval efficiency.

### 15.4 Parallel Throughput

When parallel scheduling exists, track:

- worker utilization;
- parallel tasks completed;
- conflicting edits;
- candidate success rate;
- merge conflict rate;
- wall-clock improvement.

## 16. Engineering Benchmark Suite

Create:

```text
benchmarks/engineering-suite/
```

The benchmark SHOULD include representative software-engineering tasks such as:

- simple bug fix;
- cross-file refactor;
- new API feature;
- persistence/database change;
- concurrency bug;
- broken test investigation;
- performance regression;
- security defect;
- large-log debugging;
- UI behavior change;
- architecture-sensitive change.

The suite MUST be reproducible.

## 17. Baseline Comparison

At minimum compare:

```text
Plain Pi + reference model
```

against:

```text
Pi + Pi Engineering Runtime + same reference model
```

DeepSeek-V4-Flash is the initial reference model.

Example thresholds MAY include:

```yaml
benchmark_policy:
  task_success:
    minimum_vs_baseline: 1.0

  context_usage:
    maximum_ratio_vs_baseline: 0.50

  operator_questions:
    maximum_vs_baseline: 1.0

  critical_regressions:
    maximum: 0
```

Exact thresholds SHOULD be established empirically and versioned.

Roadmap completion MUST NOT require artificial improvements where measurement noise makes them unreliable, but regressions MUST be visible and justified.

## 18. Roadmap Status Command

Implement:

```text
/roadmap-status
```

Example human-readable output:

```text
Pi Engineering Runtime — Roadmap 1.0

██████████████████████████████████░░ 94%

Milestones
────────────────────────────────────────
✓ M01 Package Foundation             VERIFIED
✓ M02 Engineering Ledger             VERIFIED
✓ M03 Fresh-Context Workers          VERIFIED
✓ M04 Artifact Store                 VERIFIED
✓ M05 Context Broker                 VERIFIED
✓ M06 Clean-Room Challenge           VERIFIED
✓ M07 Worktree Isolation             VERIFIED
✓ M08 Candidate Tournament           VERIFIED
✓ M09 Risk Orchestration             VERIFIED
◐ M10 Parallel Task DAG              IMPLEMENTED
✓ M11 Advanced Verification          VERIFIED

Verified:             10
Implemented:           1
Needs reverification:  0
Blocked:               0
Deferred:              0
Not started:           0

Roadmap complete: NO

Blocking completion:

M10 Parallel Task DAG
  ✗ DAG-17 Concurrent conflict test
  ✗ DAG-21 Crash recovery dogfood evidence
```

## 19. Machine-Readable Roadmap Check

Provide a CLI command such as:

```bash
pi-engineering roadmap check
```

Behavior:

```text
exit 0 => roadmap complete
exit 1 => roadmap incomplete
exit 2 => roadmap definition invalid
exit 3 => evidence store unavailable/corrupt
```

Optional JSON:

```bash
pi-engineering roadmap check --json
```

Example:

```json
{
  "roadmap": "1.0",
  "complete": false,
  "verified": 10,
  "required": 11,
  "blockingMilestones": ["M10"],
  "releaseGate": "FAIL"
}
```

## 20. CI Integration

CI SHOULD include:

```bash
npm test
npm run typecheck
npm run roadmap:check
```

For a release candidate, roadmap check MUST fail when:

- required milestone is not VERIFIED;
- evidence is stale;
- critical/high findings remain;
- release-wide benchmark gate fails;
- mandatory dogfood evidence is absent.

Normal development branches MAY allow an incomplete roadmap.

Release pipelines MUST NOT.

## 21. Roadmap Schema Validation

Roadmap YAML MUST have a formal schema.

Validate:

- unique milestone IDs;
- unique criterion IDs;
- valid dependency references;
- no dependency cycles;
- valid statuses;
- evidence references exist;
- required milestones cannot be silently deferred;
- milestone scope syntax;
- release gate syntax;
- benchmark policy syntax.

Invalid roadmap definitions MUST fail roadmap checking.

## 22. Dependency Graph

The roadmap engine MUST construct a milestone dependency DAG.

Example:

```text
M01 Foundation
 ├─ M02 Ledger
 ├─ M03 Workers
 │    └─ M06 Challenge
 └─ M04 Artifact Store
      └─ M05 Context Broker
           └─ M07 Worktrees
                └─ M08 Tournament
```

A milestone MUST NOT become VERIFIED if required dependencies are not VERIFIED.

The DAG MAY later feed AutoSpec parallel scheduling.

## 23. Stop Condition for Autonomous Engineering

This feature exists partly so autonomous Pi knows when to stop.

`/engineer` or equivalent autonomous development commands MUST NOT invent additional roadmap work after the active roadmap version is complete.

When:

```text
ROADMAP_COMPLETE=true
```

the runtime SHOULD respond:

```text
Roadmap 1.0 is complete.

All required milestones and release gates are verified.

No required roadmap work remains.

Suggested next actions:
- create Roadmap 1.1;
- select an optional backlog item;
- prepare a release.
```

The autonomous loop MUST terminate cleanly.

## 24. Preventing Endless Self-Improvement

The runtime MUST distinguish between:

```text
required roadmap work
```

and:

```text
ideas discovered during development
```

New ideas SHOULD enter a backlog unless they are required to satisfy an existing acceptance criterion.

Example:

```yaml
backlog:
  - id: B-104
    title: Add interactive visualization of worker context
    discovered_during: M05
```

This MUST NOT automatically make Roadmap 1.0 incomplete.

Only an explicit roadmap-version update may add required work.

## 25. Waivers

Rarely, a release may need an explicit waiver.

Waivers MUST be:

- explicit;
- machine-readable;
- attributed;
- scoped;
- reasoned;
- expiring where appropriate.

Example:

```yaml
waivers:
  - id: W-003
    milestone: M11
    criterion: M11-A7
    reason: Upstream compiler bug prevents sanitizer run
    approved_by: operator
    expires: 2026-10-15
```

An LLM MUST NOT create or approve its own waiver.

Waivers SHOULD be highly visible in `/roadmap-status`.

## 26. Evidence Storage

Large evidence MUST use the Artifact Store.

Examples:

```text
artifact://tests/unit/8102
artifact://benchmark/eng-suite/228
artifact://dogfood/441
artifact://review/992
```

Roadmap state stores compact metadata and references, not giant logs.

This preserves the system's low-token/context design.

## 27. Roadmap API

Core interfaces SHOULD resemble:

```ts
interface RoadmapEngine {
  load(version?: string): Promise<Roadmap>;
  evaluate(): Promise<RoadmapEvaluation>;
  status(): Promise<RoadmapStatus>;
  check(): Promise<RoadmapCheckResult>;
}

interface MilestoneEvaluator {
  evaluate(milestone: Milestone): Promise<MilestoneEvaluation>;
}

interface EvidenceStore {
  put(evidence: Evidence): Promise<EvidenceRef>;
  get(ref: EvidenceRef): Promise<Evidence>;
  validate(ref: EvidenceRef): Promise<EvidenceValidity>;
}

interface EvidenceInvalidator {
  affectedMilestones(change: RepositoryChange): Promise<string[]>;
}

interface ReleaseGateEvaluator {
  evaluate(roadmap: Roadmap): Promise<ReleaseGateResult>;
}
```

Interfaces MAY differ if a simpler implementation is superior.

## 28. Recommended First Implementation

Implement incrementally.

### Phase A — Structured Roadmap

Implement:

- roadmap YAML;
- schema validation;
- milestone DAG;
- milestone states;
- acceptance criteria.

### Phase B — Evidence

Implement:

- evidence records;
- artifact references;
- commit SHA binding;
- evidence validation.

### Phase C — Status

Implement:

- `/roadmap-status`;
- human-readable report;
- JSON report.

### Phase D — Machine Completion

Implement:

```bash
pi-engineering roadmap check
```

with deterministic exit codes.

### Phase E — Invalidation

Implement:

- changed-path tracking;
- milestone scope;
- VERIFIED → NEEDS_REVERIFICATION.

Start conservatively with path-based invalidation.

### Phase F — Release Gate

Implement:

- global test gate;
- dogfood gate;
- fresh-review gate;
- documentation gate.

### Phase G — Benchmark Gate

Integrate engineering benchmark results and context/autonomy metrics.

Do not block early development on a perfect benchmark suite.

## 29. Dogfood Requirement

This roadmap system MUST manage its own implementation roadmap as soon as it is sufficiently functional.

The implementation should transition from prose `docs/ROADMAP.md` to the structured roadmap format.

The feature is not considered fully verified until Pi Engineering Runtime has successfully used it to:

1. select incomplete work;
2. verify a milestone;
3. invalidate stale evidence after a relevant change;
4. reverify the milestone;
5. produce `/roadmap-status`;
6. produce a failing roadmap check;
7. later produce a successful roadmap check.

## 30. Acceptance Criteria

### AC-1 Structured roadmap

A versioned roadmap can be parsed and validated.

### AC-2 Deterministic milestone state

Milestone status is computed from implementation/evidence state and cannot be set to VERIFIED merely by model prose.

### AC-3 Evidence references

Every VERIFIED milestone has resolvable evidence.

### AC-4 Freshness

Relevant source changes invalidate stale verification evidence.

### AC-5 Dependencies

A milestone cannot verify while required dependencies remain incomplete.

### AC-6 Status UI

`/roadmap-status` clearly reports roadmap progress and exact blockers.

### AC-7 CLI check

`pi-engineering roadmap check` returns deterministic exit codes.

### AC-8 CI compatibility

The check can be used directly in CI.

### AC-9 Release gate

A roadmap cannot complete until global release gates pass.

### AC-10 Autonomous stop

`/engineer` stops selecting required work when the active roadmap is complete.

### AC-11 Backlog separation

New ideas do not silently reopen a completed roadmap.

### AC-12 Dogfood

The roadmap engine successfully manages Pi Engineering Runtime's own roadmap.

## 31. Initial Roadmap Migration

Once implemented, migrate the current project roadmap into a first structured release.

Suggested:

```yaml
roadmap:
  version: "1.0"
  codename: standalone-engineering-runtime
```

Likely milestone families:

```text
M01 Package/Foundation
M02 Engineering Ledger
M03 Fresh-Context Workers
M04 Artifact Store
M05 Context Broker
M06 Autonomy/Telemetry
M07 Clean-Room Challenge
M08 Worktree Isolation
M09 Risk-Adaptive Orchestration
M10 Candidate Tournament
M11 Parallel Task DAG
M12 Advanced Verification
```

AutoSpec and InferWeave adapters SHOULD initially remain outside this 1.0 roadmap unless the project explicitly decides otherwise.

## 32. Pi Implementation Instructions

When implementing this specification:

1. read the current repository and roadmap first;
2. do not assume existing documentation matches implementation;
3. preserve existing dogfood functionality;
4. keep roadmap logic model-independent;
5. use deterministic logic wherever possible;
6. store large evidence externally through artifacts;
7. use fresh-context review only where review is a required evidence type;
8. do not let model output directly mark milestones VERIFIED;
9. dogfood the feature against the repository's own roadmap;
10. continue autonomously through implementation, tests, review, repair, and commit.

Do not ask the operator to choose ordinary implementation details.

Recommendation equals action.

## 33. Completion Definition

The feature is considered successfully implemented when the following sequence works:

```text
Roadmap loaded
      ↓
Milestones evaluated
      ↓
Acceptance evidence resolved
      ↓
Stale evidence invalidated
      ↓
Dependencies checked
      ↓
Release gates evaluated
      ↓
/roadmap-status generated
      ↓
roadmap check returns deterministic result
      ↓
autonomous engineer either:
    continues required work
or
    stops because roadmap is complete
```

The final system must be able to answer:

> **Is Roadmap 1.0 complete?**

without relying on an LLM's opinion.

The answer must be derived from evidence.
