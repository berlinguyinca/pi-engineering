# Phase 8 — OMP skills audit, adoption and continuous evaluation

## Scope and evidence
Upstream: https://github.com/can1357/oh-my-pi. Inspect current HEAD and record SHA. The following checked-in skills were directly located at audit time:
- `.omp/skills/semantic-compression/SKILL.md`
- `.omp/skills/tool-prompt-optimization/SKILL.md`
Do NOT assume these are the complete set of the author's personal skills. Inventory repository-local, built-in, registry, extension-bundled, and any separately identified public skill repositories. Do not inspect private user skills without authorization.

## Mandatory audit
1. Enumerate tracked `**/SKILL.md`, skills manifests, skill directories, built-in commands, managed skill implementations, registry/lockfile behavior, and cross-provider discovery paths. Capture SHA, path, name, description, ownership/license, triggers, dependencies, executable scripts, security implications, overlap, test coverage, and adoption verdict.
2. Inspect `docs/skills.md`, `docs/skills/authoring-*.md`, `docs/tools/learn.md`, `docs/tools/manage_skill.md`, `packages/coding-agent/src/extensibility/skills.ts`, `src/discovery/*`, and OMP auto-learn/skillshare implementation.
3. Inventory Pi Engineering existing skills, prompts, commands, instructions and extensions; map exact duplicates, complementary functions, and conflicting instructions.
4. Categorize each candidate: ADOPT AS-IS / ADAPT / UPSTREAM / KEEP CUSTOM / REJECT / DEFER. Cite source paths and behavioral evidence. Do not duplicate OMP skill discovery, registry, or lockfile systems.
5. Explicitly test whether OMP extension-bundled `skills/<name>/SKILL.md` is sufficient for Pi Engineering packaging; prefer a version-pinned extension skill pack over copying upstream files.

## Priority experiments
A. Semantic compression: inventory every MUST/NEVER, identifier, default, error, safety constraint and unit; compress bounded worker prompts and handoffs only; compare token counts and blind task-completion/constraint-retention. Reject variants that drop safety invariants, even if smaller. Do not compress ledger evidence or authoritative source data destructively.
B. Tool-prompt optimization: inspect real wire schema, prompts and git blame before trimming; ablate with representative small and large models; measure tool choice, invalid calls, correction loops, cost and latency. No mandatory paid provider keys; use available models and skip unsupported probes explicitly.
C. Auto-learn/managed skills: verify opt-in settings, approvals, project/global scope, persistence and conflict precedence. Candidate skill generation MUST require evidence, provenance and human/independent review before promotion to shared/global instructions. Untrusted agent outputs cannot silently become mandatory policies.
D. Skill registry/lockfiles: reproducible, SHA-pinned skill packs; allow offline operation; prohibit automatic network installs and arbitrary script execution without policy approval. Test collision precedence, namespacing, and rollbacks.
E. Cross-agent portability: determine actual compatibility with Claude/Codex/Agents skill layouts; never assume equivalent runtime semantics.

## Ownership boundaries
OMP owns skill discovery, loading, precedence, registry and invocation. Pi Engineering owns engineering-specific skill content, role gates, candidate evaluation and provenance. Hindsight owns durable learned facts where configured; avoid parallel memory stores for the same facts. Herdr may display inventory, adoption state and metrics but is not a prerequisite.

## Safety and performance gates
- Preserve standalone mode with one model and no external infrastructure.
- No automatic changes to upstream or shared global skills without review.
- Pin and license-check third-party content before bundling; treat skill instructions and scripts as untrusted until reviewed.
- Small-model evaluation: run representative tasks at 60k, 100k, 120k contexts where supported; record pass rate, safety-constraint retention, prompt tokens, retries, wall time, and context growth.
- Reproducibility: record commit SHA, skill version/digest, model, prompt fixture, tool schema and test output.
- Existing `/engineer`, `/review`, `/verify`, `/plan`, `/execute`, ledger, worktree guards and recovery must not regress.

## Deliverables
`reports/skills-inventory.csv`, `reports/skills-overlap-matrix.md`, `reports/skills-adoption-decisions.md`, `reports/skills-benchmarks.md`, `reports/skill-security-review.md`, version-pinned manifest/lockfile, migration PRs, rollback documentation, and independent reviewer approval. Mark unknowns UNKNOWN, not ABSENT.

## Implementation sequence
Inventory → review source/history → choose minimal pilots → baseline → implement adapters/skill packs → A/B tests → independent review → staged promotion → prune duplicates. Every phase uses a separate worktree and PR. No code deletion until equivalent behavior passes acceptance tests.
