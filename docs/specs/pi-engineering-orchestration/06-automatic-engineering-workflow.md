# 06 — Automatic Engineering Workflow

## Objective

Normal language should invoke the engineering lifecycle automatically.

Canonical workflow:

```text
request
 -> classify
 -> create mission
 -> derive acceptance criteria
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
