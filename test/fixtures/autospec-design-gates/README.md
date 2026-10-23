# autospec-design-gates fixtures

Genuine output of `scripts/autospec-design-gates.sh` (berlinguyinca/autospec at
`bcf8fd4f7be7dc17fb00860fd731f5092c55364c`), run against throwaway repos, with
the absolute temp paths in `config_path` / `rules_file` rewritten to
`/fixture/repo/...`. Inputs:

- `rules.yaml`: `rules.yaml` of berlinguyinca/autospec-design at
  `167ed87abfac8bcda2044927e4d4077373b90db8`.
- pack: `docs/application/ai-platform.pack.json` of berlinguyinca/autospec-baselines
  at `581e09620d41945cb699207cf9afa3ec65b1ec53` (only its `qualityGates` are used).

| file | how it was produced |
| --- | --- |
| `pass-full.json` | every `check: auto` rule mapped to `true` -> `PASS (14 run, 0 failed, 0 unmapped)` |
| `pass-partial.json` | only `design.tokens.no-raw-color` and `motion.reduced-motion-fallback` mapped -> `PASS` but 12 rules unmapped, 5 of them blockers |
| `fail-partial.json` | `design.tokens.no-raw-color` mapped to a failing command -> `FAIL (2 run, 1 failed)` |
| `skipped.json` | no `.autospec/design-gates.yml` -> `SKIPPED`, reason `no-config` |

None of the reports carries a commit (the script does not write one). Tests add
`commit_sha` themselves; that is the AutoSpec-side change Pi needs for a report to
be usable as evidence.

The Constitution repo (`autospec-constitution` at
`f7ad0f45fdfb944a8b48d9bee1b68352b20853ad`) ships the quality-gate SCHEMA but no
gate instances, so the quality-law test inputs are built from
`schemas/quality-gate.schema.json` and `schemas/profile.schema.json`, not copied.
