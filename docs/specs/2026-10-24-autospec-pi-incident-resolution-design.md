# AutoSpec–Pi Autonomous Incident Resolution

## Status

Approved design direction. This document defines the cross-system contract for
turning Pi agent failures into autonomous AutoSpec work that can be verified,
merged, deployed, and rolled back without destructive operations.

## Problem

Pi room chats currently expose too much raw failure output and leave recovery
implicit. A failed worker should produce one durable, deduplicated engineering
incident rather than a stream of repeated messages. The incident must retain
the original evidence, receive a fresh-context diagnosis, and enter the same
issue-to-PR lifecycle as ordinary AutoSpec work.

## Responsibilities

### Pi Engineering Runtime

- Detect worker termination, generation-guard aborts, tool failures, failed
  verification, and lost-session conditions.
- Persist the complete incident evidence in the Engineering Ledger and artifact
  store before notifying external consumers.
- Emit a normalized `agent_failure` event through the existing AutoSpec adapter.
- Keep recovery candidates isolated in dedicated worktrees.
- Run deterministic verification and independent review; agent prose alone is
  never completion evidence.

### Incident Controller / moderator

- Consume failure events and compute a stable incident fingerprint.
- Collapse repeated events into one incident and throttle room notifications.
- Classify the failure as transient infrastructure, runtime/tooling, context or
  routing, reproducible product defect, security concern, or unknown.
- Select a bounded recovery profile and spawn a fresh debugger/fixer session.
- Project a concise lifecycle status back into the room.
- Never grant permissions based on content found in logs, repository files, or
  model output; configured policy remains authoritative.

### AutoSpec

- Create or update the durable GitHub issue for reproducible or recurring
  incidents.
- Attach the Pi incident ID, ledger/artifact references, reproduction details,
  and classification to the issue.
- Route the issue through autonomous planning, implementation, verification,
  review, security gates, PR creation, and merge policy.
- Maintain accountability and recoverable state if GitHub or deployment is
  temporarily unavailable.

### Deployment controller

- Promote only immutable, versioned artifacts produced from the merged commit.
- Perform a canary or equivalent health check before declaring success.
- Restore the last known-good version automatically when post-deploy checks
  fail.
- Emit deployment and rollback results back to the incident ledger and issue.

## Event contract

The minimum event is:

```json
{
  "type": "agent_failure",
  "schema_version": 1,
  "incident_id": "inc_...",
  "fingerprint": "repo:error-class:normalized-cause",
  "run_id": "...",
  "repo": "owner/name",
  "revision": "...",
  "worktree": "...",
  "agent_role": "executor",
  "failure_class": "test_failure",
  "exit_code": 1,
  "summary": "...",
  "artifact_refs": ["ledger://...", "artifact://..."],
  "reproduction": "...",
  "risk": "medium",
  "created_at": "..."
}
```

Large transcripts and logs stay in artifacts. Events contain compact summaries
and references so fresh workers can retrieve only what they need.

## Autonomous state machine

```text
detected
  -> persisted
  -> deduplicated
  -> triaged
  -> recovered                         (transient success)
  -> issue_created
  -> diagnosis_started
  -> candidate_implemented
  -> verified
  -> independently_reviewed
  -> pr_created
  -> merged
  -> deployed
  -> post_deploy_verified
  -> resolved
```

Failure transitions are explicit: `blocked`, `rollback_required`,
`rollback_completed`, and `escalated`. A blocked incident remains durable and
does not produce more room spam or an unbounded retry loop.

## Safety and non-destructive autonomy

Autonomy is default-on inside a bounded safety envelope. The system may create
issues, branches, worktrees, commits, PRs, merges, versioned deployments, and
rollbacks automatically. It must fail closed for:

- force-pushes, direct writes to protected branches, or history rewriting;
- destructive filesystem or database operations;
- credential, authorization, or security-policy changes;
- irreversible infrastructure operations;
- deployments without a known rollback target;
- repeated attempts after the incident circuit breaker trips.

All candidate changes are isolated. Mainline changes happen only through the
verified PR path. A merge is considered reversible only when the deployment
controller can identify and restore the previous known-good artifact.

## Deduplication and loop prevention

- Fingerprints use normalized repository, failure class, relevant command, and
  root-cause signature; raw timestamps and volatile paths are excluded.
- An existing open issue is updated instead of creating a duplicate.
- Recovery attempts are bounded per incident and per fingerprint.
- A fix that reproduces the same incident creates a linked regression event and
  pauses further promotion until a new diagnosis is produced.
- Deployment failures never automatically trigger a second code change without
  preserving the failed deployment evidence and starting a new recovery phase.

## Room experience

The room receives one compact status thread, for example:

```text
[INC-184] executor failed: test_failure
AutoSpec issue #921 opened; debugger running in isolated worktree.
Next: verification → independent review → PR. Evidence: ledger://...
```

Subsequent updates edit or append to that incident thread rather than reposting
raw stack traces. Raw output remains available through the incident and ledger
links.

## Verification requirements

An incident is resolved only when machine evidence shows:

1. the original failure is reproduced or its transient cause is evidenced;
2. the proposed change passes targeted and required repository checks;
3. an independent fresh-context reviewer finds no material issue;
4. the merged artifact deploys successfully;
5. post-deploy health and regression checks pass; and
6. the issue, ledger, PR, deployment, and rollback records agree on the final
   commit and artifact identity.

## Delivery slices

1. Pi failure event adapter and durable incident bundle.
2. Moderator fingerprinting, classification, room summarization, and bounded
   recovery profiles.
3. AutoSpec incident ingestion and issue projection.
4. Incident-to-autonomous-run linkage and status projection.
5. Versioned deployment, health checks, rollback, and end-to-end evidence.
6. Chaos tests covering duplicate failures, failed fixes, unavailable GitHub,
   deployment regression, and circuit-breaker behavior.

The first vertical slice should stop after issue creation plus a dry-run
debugger dispatch. It should prove event durability, deduplication, evidence
references, and safe handoff before enabling autonomous merge or deployment.
