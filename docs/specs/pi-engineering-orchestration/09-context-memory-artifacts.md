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
  base_ref: abc123
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

## Provenance

Each artifact should include:

- mission
- task
- execution
- timestamp
- source model/process
- base ref
- content hash where practical
