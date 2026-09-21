# 07 — Review, Repair, Validation, and Completion Gates

## Principle

The implementation worker cannot be the sole authority that its own work is correct.

## Independent review

Material code changes require a fresh reviewer.

Reviewer context:

- mission goal
- acceptance criteria
- constraints
- integrated diff
- relevant architecture notes
- validation evidence

Do not provide full implementation chain-of-thought or unnecessary worker transcript.

## Review specialties

Possible review roles:

- correctness
- tests
- security
- architecture
- API compatibility
- migration/data safety
- performance

Select only those justified by risk.

## Structured finding schema

```json
{
  "finding_id": "F-123",
  "severity": "blocking",
  "category": "correctness",
  "file": "src/auth/service.ts",
  "line": 142,
  "summary": "...",
  "evidence": "...",
  "recommended_action": "..."
}
```

## Repair loop

```text
review
 -> findings
 -> repair task(s)
 -> validation
 -> re-review when necessary
```

Avoid infinite loops.

Configure:

- maximum review/repair cycles
- escalation after repeated failure
- user decision gate for fundamental ambiguity

## Completion gate

Mission may transition to COMPLETE only if:

- all required tasks finished,
- all mandatory validations passed,
- all mandatory review roles passed or have accepted dispositions,
- no blocking findings remain,
- no required child/process still running,
- integration candidate is current,
- completion evidence was generated.

Completion gate is deterministic application logic.

## Completion evidence

Produce:

```json
{
  "mission_id": "...",
  "base_ref": "...",
  "final_ref": "...",
  "files_changed": [],
  "validations": [],
  "reviews": [],
  "resolved_findings": [],
  "known_risks": [],
  "acceptance_criteria": [
    {"criterion": "...", "status": "passed", "evidence": "..."}
  ]
}
```
