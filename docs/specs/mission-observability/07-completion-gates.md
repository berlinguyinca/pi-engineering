# 07 — Communication, Action, and Completion Gates

## Required architecture

Do not use a single global "mission gate."

Implement or refactor around three conceptual gates.

## 1. Communication Gate

Default: OPEN.

Allows:

- ordinary Pi responses,
- progress updates,
- user questions,
- mission steering,
- partial findings,
- warnings,
- error reports,
- inspection of other missions.

An active mission alone is never grounds to close this gate.

## 2. Action Gate

Controls whether a particular operation is permitted.

Examples:

- destructive operation,
- production mutation,
- privileged infrastructure action,
- high-impact approval,
- credential access.

This gate is independent from user-facing communication.

## 3. Completion Gate

Strictly controls terminal completion claims and state transition to `COMPLETE`.

Completion requires current, non-stale evidence according to Pi-Engineering policy, such as:

- required DAG tasks complete,
- worker results harvested,
- changes integrated,
- expected repository mutations exist,
- required tests/validation pass,
- fresh independent review completed,
- blocking findings repaired,
- required final validation passed,
- no required worker remains active,
- no unresolved blocker remains.

## UI semantics

Before gate pass:

```text
~98% · FINAL VALIDATION
Completion: NOT YET VERIFIED
```

After pass:

```text
100% · VERIFIED COMPLETE ✓
```

## Forbidden behavior

```ts
if (mission.active) {
  suppressAllAssistantOutput();
}
```

and:

```ts
if (modelSaysDone) {
  mission.state = "COMPLETE";
}
```

are both invalid.

## Multiple missions

Completion gating is mission-local.

Mission A being active or blocked must not prevent Mission B or ordinary conversation from producing output.
