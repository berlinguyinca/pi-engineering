# autospec-dag fixtures

Provenance (read-only copies; the AutoSpec repo was not modified):

- `valid.json`: the `mission[0]` and `task[*]` records of
  `tests/fixtures/protocol/valid.json` in berlinguyinca/autospec at
  `bcf8fd4f7be7dc17fb00860fd731f5092c55364c`, regrouped as `{mission, tasks}`.
  Task `t-2` has `executor: autospec-managed`, which Pi refuses to ingest; tests
  flip it to `pi-local` for the accepting cases.
- The record shapes are validated by `src/integrations/autospec/protocol.ts`, a
  hand-written mirror of `schemas/autospec-protocol-{mission,task}.v1.schema.json`
  at the same sha (the schemas are not available at runtime). The full schema
  copies already live in `../autospec-protocol/schemas`.

Derived cases (cycle, unknown required extension, cross-repo issue refs, ...) are
built in `test/unit/autospec-dag-ingest.test.ts` by mutating `valid.json`.
`autospec.issue_refs` is a Pi-side convention (task.v1 has no issue field);
AutoSpec does not emit it yet.
