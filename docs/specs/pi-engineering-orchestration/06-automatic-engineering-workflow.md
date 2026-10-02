# 06 — Automatic Engineering Workflow

## Objective

Normal language should invoke the engineering lifecycle automatically.

Canonical workflow:

```text
request
 -> classify
 -> create mission
 -> derive acceptance criteria
 -> resolve and authorize workspace manifest
 -> preflight role access and repository bindings
 -> scout if needed
 -> plan/decompose
 -> schedule workers
 -> integrate
 -> validate
 -> independent review
 -> repair findings
 -> revalidate
 -> completion gate
```

Preflight must occur before mutating work. A mission that explicitly names an
absolute workspace may authorize it autonomously after canonicalization and
safety validation. Broad or multi-repository work must be decomposed into
bounded repository-scoped tasks with acceptance coverage before dispatch.

## Fast path

Tiny, low-risk changes should not suffer unnecessary ceremony.

Fast-path example:

```text
small documentation typo
 -> direct edit
 -> lightweight validation
 -> complete
```

But fast path must still obey hard policies if triggered.

## Planning threshold

Do not force an expensive planner for every trivial task.

Suggested logic:

```text
if task is small + localized + low risk:
    skip explicit planning agent
else:
    scout/plan/decompose
```

## Acceptance criteria

Every material mission should have acceptance criteria before implementation starts.

They may be:

- supplied directly by the user,
- inferred by parent,
- enriched by repository conventions,
- updated when new constraints emerge.

Changes to acceptance criteria must be logged.

Every material acceptance criterion has a stable ID and must be covered by a
task and current revision-bound evidence. Workflow activity does not substitute
for verified acceptance coverage.

## Escalation

Workflow class may escalate dynamically.

Examples:

```text
investigation -> engineering
engineering -> security-sensitive
simple implementation -> migration
```

## User interruptions

When the user adds a constraint while work is active:

1. update mission constraints,
2. determine affected tasks,
3. steer or cancel affected executions,
4. invalidate stale results if necessary,
5. reschedule.

The same invalidation and rescheduling rules apply to automatic scope repair,
checkpoint recovery, task splitting, and blocked-mission resumption. Preserve
the mission ID and failed-attempt audit history.

## Autonomous spec approval

Material mutation workflows may run an autonomous spec-approval stage before
implementation tasks exist. That stage drafts a structured spec, reviews the
exact revision and normalized plan, refines within a bounded budget, and
persists an exact-revision policy approval.

Autonomous spec approval is **exact-revision policy authorization**, not human
approval, not Plannotator approval, and not implementation correctness
evidence. It authorizes only the exact reviewed spec revision and normalized
task plan to enter the execution pipeline, and never satisfies implementation
validation, candidate review, acceptance evidence, or mission completion.

See `docs/superpowers/specs/2026-09-28-autonomous-spec-approval-design.md`.
