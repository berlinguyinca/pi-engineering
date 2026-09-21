# 00 — Master Spec: Mission Observability

## Problem

Pi-Engineering missions are durable units of autonomous engineering work, but the current experience can reduce all active work to an opaque `MISSION` indicator. Users cannot tell whether a mission is:

- making progress,
- running tests,
- waiting for a worker,
- waiting in InferWeave admission,
- blocked on a dependency,
- reviewing changes,
- repairing findings,
- looping,
- hung,
- or actually idle.

This damages trust and makes long-running autonomous work difficult to supervise.

## Core invariant

**An active mission MUST NOT suppress ordinary user-facing communication.**

A Mission can gate terminal completion claims, and individual actions may be subject to authority/safety approval, but ordinary progress communication remains open.

The system must separate:

1. **Communication Gate** — normally open.
2. **Action Gate** — policy/authority dependent.
3. **Completion Gate** — strict evidence-based verification.

## Mission summary contract

Every active mission must expose a canonical summary object:

```ts
interface MissionObservabilitySummary {
  missionId: string;
  title: string;
  state: MissionState;
  phase: MissionPhase;

  progress: {
    approximatePercent: number; // 0..100
    verifiedComplete: boolean;
    basis: "weighted_dag";
  };

  health: "active" | "waiting" | "slow" | "stalled" | "blocked" | "failed";

  currentObjective?: string;
  currentActivity?: {
    type: ActivityType;
    summary: string;
    workerId?: string;
    file?: string;
    command?: string;
  };

  workers: {
    active: number;
    waiting: number;
    failed: number;
  };

  lastHeartbeatAt?: string;
  lastMeaningfulProgressAt?: string;

  waitingReason?: WaitingReason;
  completionStatus:
    | "not_ready"
    | "validating"
    | "review_blocked"
    | "repairing"
    | "final_validation"
    | "verified_complete";
}
```

## Mission phases

Canonical phases:

```text
CREATED
PLANNING
EXECUTING
INTEGRATING
VALIDATING
REVIEWING
REPAIRING
FINAL_VALIDATION
COMPLETE
```

Side states may include:

```text
BLOCKED
FAILED
CANCELLED
NEEDS_HUMAN_DECISION
NEEDS_CREDENTIAL
NEEDS_EXTERNAL_RESOURCE
NEEDS_HIGH_IMPACT_APPROVAL
```

## User experience

The generic `MISSION` marker must be replaced with a compact mission card/header.

Example:

```text
● AIMS Console Refactor                              ~68%
████████████████████████░░░░░░░░░░░░

Implementing EventDrawer.tsx
3 workers · tests 34/81 · last activity 3s ago
EXECUTING → VALIDATING → REVIEWING → COMPLETE
```

The percentage is approximate until completion. Only a passed CompletionGate may render:

```text
100% · VERIFIED COMPLETE ✓
```

## Requirements

- progress derives from the Mission DAG, never from freeform LLM claims;
- observable work is summarized from tool/process/repository/test/orchestrator events;
- hidden chain-of-thought is never shown;
- heartbeat and meaningful progress are distinct;
- waiting states include a reason;
- stalled missions are detected automatically;
- long-running missions emit concise user-visible updates on meaningful transitions;
- clicking the mission summary opens a full Mission Inspector;
- multiple missions can coexist in a conversation/session;
- one active mission cannot monopolize the output channel;
- telemetry supports Pi-Web now and Herdr aggregation later.

## Success criteria

A user looking at Pi-Web must be able to answer, within 5 seconds:

1. What mission is running?
2. Roughly how far along is it?
3. What is it doing right now?
4. When did it last make meaningful progress?
5. Is it healthy, waiting, stalled, blocked, or failed?
6. What workers are involved?
7. What happens next?
8. Has completion actually been verified?
