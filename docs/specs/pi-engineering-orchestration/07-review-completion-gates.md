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

The reviewer must receive repository-scoped tools plus a candidate evidence
manifest bound to the workspace manifest, repository, base SHA, candidate SHA,
diff hash, and acceptance criteria. A status document or worker summary cannot
substitute for the actual diff and validation artifacts.

When no distinct reviewer model exists, review continues in a fresh session on
the current model with a visible reduced-independence warning. The review gate
is not skipped.

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

Normalize external review severities as follows:

- `blocker`, `critical`, `high` -> `blocking`;
- `medium` -> `major`;
- `low`, `info` -> `minor`.

`request_changes`, malformed review output, inaccessible candidate evidence,
and unresolved blocking findings fail the review gate.

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

A successful repair worker does not resolve a finding. Resolution requires
targeted validation and fresh review evidence tied to the repaired candidate.
Repeated unchanged findings consume the typed recovery budget and then stop
with the required condition for resumption.

## Completion gate

Mission may transition to COMPLETE only if:

- all required tasks finished,
- all mandatory validations passed,
- all mandatory review roles passed or have accepted dispositions,
- no blocking findings remain,
- no required child/process still running,
- integration candidate is current,
- completion evidence was generated.

Completion additionally requires:

- every material acceptance criterion is passed by current evidence;
- every failed task is unresolved or explicitly superseded by replacements
  covering the same objective and acceptance criteria;
- required blocked, canceled, and skipped tasks are accounted for;
- all evidence matches the final workspace manifest and repository-head vector;
- no stale or unfenced execution can still mutate the candidate.

Candidate changes, workspace rebinding, repair, integration, or relevant
dependency changes invalidate affected evidence. Historical green executions
must never satisfy gates for a newer candidate. A no-target validation cannot
satisfy a mutation gate.

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
