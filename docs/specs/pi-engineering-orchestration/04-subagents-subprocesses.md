# 04 — Pi Subagents, Child Sessions, and Subprocesses

## Separation of concerns

### Pi child/subagent

Use when reasoning is required:

- repository exploration
- design
- implementation
- debugging
- architectural analysis
- code review
- security review
- documentation

### Subprocess

Use when deterministic execution is required:

- unit tests
- integration tests
- type checking
- linting
- formatting checks
- builds
- dependency install
- containers
- compiler execution
- git inspection
- static analysis tools

Do not waste model context babysitting a deterministic command.

## Subprocess supervisor

Must support:

- start
- stdout/stderr streaming
- exit code
- timeout
- kill
- cancel
- resource metadata where available
- environment policy
- working directory
- artifact capture
- structured test parsing where practical

Subprocess completion emits events.

Example:

```text
process.started
process.output
process.failed
process.completed
```

## Background execution

Long-running child agents and processes should not block the parent session.

The parent remains interactive and can:

- inspect status
- steer children
- cancel
- add constraints
- reprioritize tasks

## Recursive delegation

Allow bounded recursive delegation only under explicit policy.

Required limits:

- maximum depth
- maximum children per task
- maximum concurrent agents
- budget limits
- cycle detection

## Child handoff

Every child should produce a machine-readable final handoff:

```json
{
  "summary": "...",
  "status": "complete",
  "files_changed": [],
  "tests_run": [],
  "risks": [],
  "open_questions": [],
  "artifacts": []
}
```
