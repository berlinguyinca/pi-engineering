# 11 — Event Model and Observability

## Event stream

Initial event types:

```text
mission.created
mission.updated
mission.completed
mission.failed

task.created
task.ready
task.started
task.completed
task.failed
task.retried
task.canceled

agent.spawned
agent.steered
agent.completed
agent.failed

process.started
process.output
process.completed
process.failed

repository.changed
integration.started
integration.completed
integration.conflict

validation.started
validation.passed
validation.failed

review.started
review.finding
review.passed

repair.started
repair.completed

approval.requested
approval.received
```

## Storage

Initial recommendation:

- durable SQLite/Postgres state store
- append-only event table/log
- structured JSON payloads

Do not add Kafka/NATS/Redis solely for the first implementation unless the existing repository already requires one.

Design an event interface that can be replaced with a distributed transport later.

## Metrics

Track:

- mission duration
- queue time
- task duration
- concurrency
- child count
- subprocess duration
- retries
- failure categories
- model tokens
- model cost if relevant
- review findings
- rework cycles
- first-pass review success
- validation failures
- worktree conflicts
- user intervention rate

## PI WEB status bar/panel integration

Expose:

- current mission
- phase
- active workers
- active subprocesses
- model(s)
- tokens/s when available
- queue/wait time
- repository/worktree/branch
- blocking issue count

## Auditability

It must be possible to reconstruct:

- why a task was spawned,
- which context it received,
- which model executed it,
- what it changed,
- what validations ran,
- what reviewers found,
- why completion was allowed.
