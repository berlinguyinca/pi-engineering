# 03 — Unified Execution Broker

## Goal

Hide execution plumbing from the parent Pi session.

The parent should request logical work, not choose low-level mechanisms ad hoc.

Conceptual API:

```ts
execute(task: ExecutionRequest): Promise<ExecutionHandle>
```

## Request schema

```ts
interface ExecutionRequest {
  taskId: string;
  kind: "agent" | "process" | "review" | "integration" | "validation";
  role?: string;
  objective: string;
  contextRef?: string;
  mutatesRepo?: boolean;
  writeDomains?: string[];
  isolation?: "none" | "worktree";
  capabilities?: string[];
  modelRequirements?: ModelRequirements;
  timeoutPolicy?: TimeoutPolicy;
}
```

## Backends

Initial adapters:

1. PI WEB/Pi tracked child sessions or subsessions where suitable.
2. `pi-subagents` workflow/subagent execution.
3. supervised local OS subprocesses.

The broker should make backend choice based on task semantics and available capabilities.

## Backend selection examples

```text
repository scout
 -> fresh Pi child session/subagent

implementation worker
 -> child/subagent + worktree

fresh review
 -> new isolated child/subagent

npm test
 -> subprocess

docker build
 -> subprocess

multi-stage worker/reviewer workflow
 -> pi-subagents workflow backend
```

## Parent abstraction

Parent should not need prompts like:

```text
call spawn_subsession
then wait
then call subagent
then invoke bash
```

It should create tasks and let the broker execute them.

## Cancellation

All executions must support a common cancellation contract.

## Steering

Agent executions should support best-effort steering:

- add constraint
- reprioritize
- request status
- stop/cancel
- replace task

Steering actions must be logged as mission events.
