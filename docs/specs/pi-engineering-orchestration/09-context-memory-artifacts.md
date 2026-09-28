# 09 — Context, Memory, and Artifacts

## Objective

Keep the parent context clean and reduce duplicated tokens.

## Context packets

Children receive task-specific context envelopes.

Example:

```yaml
mission:
  goal: Implement Google authentication

task:
  objective: Add backend callback endpoint

constraints:
  - preserve password login
  - no database schema changes

repository:
  repo_id: auth-service
  base_ref: abc123
  candidate_ref: def456
  workspace_manifest_hash: sha256:...
  relevant_paths:
    - src/auth/
    - src/api/login.ts

known_facts:
  - session storage uses Redis

acceptance:
  - existing login tests pass
  - OAuth callback creates valid session
```

## Parent context

The parent should retain:

- user intent
- project constraints
- decisions
- mission summaries
- active task state
- important risks

It should not accumulate:

- giant compiler logs
- full child transcripts
- redundant file dumps

## Durable memory

OpenViking may remain the shared durable memory/context service for cross-session engineering knowledge.

PostgreSQL/SQLite/runtime stores remain authoritative for execution state.

Do not store task lifecycle state only in semantic memory.

## Artifact store

Required artifact categories:

- plans
- scout findings
- patches
- commits
- test logs
- review findings
- process output
- handoff manifests
- completion evidence

Artifacts need stable IDs/references.

Gate and checkpoint artifacts must be accessible through repository-scoped
tools regardless of the parent session cwd. An absolute path in prose is not an
artifact reference and does not establish reviewer access.

Required recovery artifacts include workspace manifests, task checkpoints,
failure classifications, recovery decisions, replacement lineage, lease/fencing
records, evidence invalidations, and external side-effect reconciliation.

## Provenance

Each artifact should include:

- mission
- task
- execution
- timestamp
- source model/process
- base ref
- content hash where practical
- repository ID, base SHA, candidate SHA, and diff hash for gate evidence
- mission generation and fencing token for mutable execution results
- acceptance criterion IDs covered by the artifact
