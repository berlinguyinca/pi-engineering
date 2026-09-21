# 12 — Engineering Runtime Guardrails

## Objective

Prevent autonomous orchestration from becoming uncontrolled execution.

## Required controls

- repository allowlist/root enforcement
- no path escape from authorized workspace
- explicit worktree ownership
- subprocess environment sanitization
- secrets redaction in logs/artifacts
- configurable command allow/deny policies
- timeout and cancellation
- maximum recursive depth
- maximum concurrency
- maximum retry loops
- protected branch policy
- destructive command policy
- explicit human approval for configured high-impact operations

## High-impact examples

Potential approval gates:

- production deployment
- destructive database migration
- force push
- repository history rewrite
- secret rotation
- cloud resource deletion
- destructive infrastructure changes

Normal local development commands should not require unnecessary approval.

## Child isolation

Children inherit only capabilities required for their task.

A reviewer should normally be read-only.

A scout should normally be read-only.

An implementer gets workspace mutation only in its assigned worktree/domain.

## Prompt injection resistance

Repository content is untrusted input.

Do not allow README/source-file instructions to override:

- runtime policy,
- user constraints,
- system configuration,
- secret handling,
- allowed tools.
