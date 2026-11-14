# OMP skills infrastructure audit (read-only)

Upstream `oh-my-pi` @ 57263720c818ab3baaeb74bf415b03592b806ae0; PE worktree @ 5ab85965fce3f4343eff776ac23d11c1bc197799. Paths below are relative to `packages/coding-agent/` unless noted. No upstream code or skill script was executed.

## 1. Inventory result
- Tracked real skills: 3, not 2: `.omp/skills/{semantic-compression,system-prompts,tool-prompt-optimization}/SKILL.md` (system-prompts also ships `small-models.md`; tool-prompt-optimization ships `scripts/probe.ts`, `scripts/probe-builtin.ts`). Spec only knew 2.
- 17+1 other tracked SKILL.md are test fixtures (`test/fixtures/skills*`, `test/marketplace/fixtures/.../greet`), not skills.
- No tracked `skills.json`, `skills.lock.json`, `.claude/`, `.agents/`, `.codex/` skill dirs. Only `.claude-plugin/marketplace.json` under docs examples.
- UNKNOWN (not ABSENT): contents of registry `https://skills.omp.sh` (wire `DEFAULT_SKILLS_URL`, packages/wire/src/skillshare.ts:18), the maintainer's private/user skills, marketplace plugins, MCP-advertised `skill://` resources (docs/skills.md "MCP-advertised skills").
- `.omp/skills` in the upstream repo is project-level and is only discovered when cwd is inside oh-my-pi (native provider walks ancestors, src/discovery/builtin.ts:~312-318). It is not shipped with the omp binary.

## 2. Discovery paths and precedence (priority-first, higher wins)
| Prio | Provider | Paths | Evidence |
|---|---|---|---|
| 100 | native | `<proj>/.omp/skills/<n>/SKILL.md` (ancestor walk), `~/.omp/agent/skills` | discovery/builtin.ts:45,312-330 |
| 95 | skillshare | skills pinned in `<proj>/.omp/skills.lock.json` or `<agentDir>/skills.lock.json`, store `~/.omp/skillshare/@scope/name/<ver>/` | discovery/skillshare.ts:1-9,28 |
| 90 | omp-plugins | `<ext-root>/skills/<n>/SKILL.md` for packages loaded via `extensions:`, `-e`, or `~/.omp/plugins/node_modules` | discovery/omp-plugins.ts:47,64-77 |
| 80 | claude | `.claude/skills` project (default on), `~/.claude/skills` (opt-in) | discovery/claude.ts:44,199-210; extensibility/settings.ts:47-53 |
| 75 | agent-plugins | root `plugin.json` packages, fixed `skills/<n>/SKILL.md`, strict Agent Skills validation | agent-plugins.ts:41,115-138 |
| 70 | claude-plugins, agents, codex | `.agent[s]/skills` (user+project, default on), `.codex/skills` (user opt-in) | claude-plugins.ts:34; agents.ts:29-30; codex.ts:48,266-268 |
| 55 | opencode | `.opencode/skills`, `~/.config/opencode/skills` | opencode.ts:49,351-352 |
| 30 | github | `.github/skills` project only | github.ts:42,287 |
| 5 | omp-managed | `~/.omp/agent/managed-skills` (auto-learn), discovered unconditionally | builtin.ts:343-365 |
Plus `skills.customDirectories` (non-recursive `*/SKILL.md`, outranks same-named provider skills, docs/skills.md "Discovery pipeline" pass 2) and MCP `skill://` fallback.
- Layout is non-recursive one level under `skills/` (docs/skills.md:25-48). Cross-provider layouts (Claude/Codex/Agents/OpenCode) are read natively but only as file layout: frontmatter semantics (`hide`, `enabled`, `globs`, `alwaysApply`) are OMP-specific and Agent Plugins uses a closed field set. Claude/Codex/agents skills may lack description (docs/skills.md "SKILL.md frontmatter"). Compatibility is layout-level only; runtime semantics (e.g. Claude `allowed-tools`, hooks) are not implemented as equivalents: UNKNOWN beyond what docs state, to be tested in Exp E.
- Foreign user-level roots are opt-in: `FOREIGN_USER_PROVIDERS` = cursor, codex, claude, claude-plugins, gemini, opencode, windsurf, github (capability/index.ts:49-58); defaults `enableCodexUser=false`, `enableClaudeUser=false`, others true (extensibility/settings.ts:47-66). Note the `agents` provider has its own toggles and is on by default for user (`~/.agents/skills`) and project.

## 3. Collision handling
- extensibility/skills.ts:150-212 `resolveCollision`: identical body+frontmatter dropped; differing: higher-precedence keeps bare name, other gets `<namespace>/<name>` (`~N` suffix if taken) with a warning. Authored > registry package; custom dir > provider (#7190).
- Raw `name` containing `/` or `\` rejected (skills.ts ~402-404; docs/skills.md).
- Exclusions (`disabledExtensions skill:<n>`, `ignoredSkills`) apply to raw and final names; `includeSkills` to final names; `manualSkills` hides from the model catalog but keeps `skill://` and `/skill:` reachable (docs/skills.md "Manual-only skills").
- Test evidence: `test/fixtures/skills-collision/*`, `test/skills.test.ts` (64 test/it), `test/skill-protocol-customdirs.test.ts`, `test/skill-url-containment.test.ts`.

## 4. Registry and lockfile (Skillshare)
- `skills.json` (manifest: `@scope/name` -> range/tag) and `skills.lock.json` (version, SRI `sha512-` integrity, resolved route) at skillshare/manifest.ts:1-40; project files in nearest `.omp/`, global in agent dir.
- Integrity is verified BEFORE unpack (skillshare/installer.ts:94-113); a store dir only counts if its stored integrity equals the lock (discovery/skillshare.ts:36-45); registry bytes differing from locked integrity are refused (installer.ts:287-292). Store is shared across projects and pruned when no lock references it. Offline: an already-stored locked version loads with no network; missing store entries are not loaded until `omp skill update`.
- Network only via explicit `omp skill install|update|search|publish` (commands/skill.ts) or `/skills ...` (slash-commands/builtin-skills.ts). Grep of call sites found no startup auto-install. Registry URL setting `skills.registryUrl`, default https://skills.omp.sh; `http:` is also accepted (client.ts:80-92). First install is trust-on-first-use of the registry; the lock gives reproducibility, not provenance. No signature check found (UNKNOWN whether registry signs).
- Script gate: versions flagged `hasScripts` (executables or `scripts/*`) prompt for confirmation; non-TTY refuses unless `--yes` (installer.ts:296-304,612-624). The installer never runs scripts; the agent may later run them via bash, subject to its approval mode (tool-approval policy is separate).
- Rollback: re-pin an exact version in `skills.json` + `omp skill update`; git-revert the lockfile. No dedicated `rollback` command found (UNKNOWN; to be tested in Exp D).
- Tests: test/skillshare/{discovery,installer,pack,tar}.test.ts.
- Spec Exp D requires SHA pinning/offline/no auto-network/no arbitrary scripts: OMP satisfies SHA-512 pinning, offline operation, explicit-network, and script confirmation; gap: pin is registry tarball integrity, not git SHA; PE-side policy for `--yes` and agent script execution must be added.

## 5. Auto-learn / managed skills
- `autolearn.enabled` default false (autolearn/settings.ts:11-22); `autolearn.autoContinue` default false (auto-runs a capture turn at stop, extra tokens); `minToolCalls` default 5 (settings.ts:38). Controller installs regardless but re-reads the live flag at each stop (autolearn/controller.ts header; sdk.ts:5876-5882).
- Tools `learn` (needs memory.backend hindsight|mnemopi|local) and `manage_skill` registered only when enabled (docs/tools/learn.md, manage_skill.md). `manage_skill` approval = write; `learn` approval is read/write depending on call (docs/tools/learn.md "Registration"). Subagents do not receive them unless explicitly listed.
- Scope: managed skills are always user/global (`~/.omp/agent/managed-skills`); there is no project-scope managed skill, and no human or independent review step before a managed skill becomes discoverable in later sessions (it is surfaced as a normal skill, priority 5, always losing to authored skills). `learn` does not refresh the live skill list; `manage_skill` does.
- Safeguards: name `[a-z0-9][a-z0-9-]{0,63}`; description sanitised (control chars, angle brackets, backticks stripped); 64000 B cap; symlink/hardlink/non-regular-file checks; lesson text neutralises prompt injection and redacts secrets (docs/tools/learn.md "Limits"). Body is NOT sanitised for instructions: an agent can write arbitrary instructions into a future skill body.
- Verdict: conflicts with spec C (evidence + provenance + review before promotion). Keep disabled in PE; if used, wrap with a PE promotion gate. DEFER.

## 6. Extension-bundled skills as PE packaging (spec item 5)
- Mechanism works at the discovery level: a package loaded via `extensions:`/`-e`/`~/.omp/plugins` exposes `skills/<name>/SKILL.md` at priority 90, above claude/agents and below native/skillshare (omp-plugins.ts:64-77; docs/skills/authoring-extensions.md:102). PE already has `package.json` `pi.extensions` (package.json:58-60), so a `skills/` dir next to it would be picked up by OMP; versioning is via the npm/package version and lockfile (package-lock.json), i.e. version-pinned without copying upstream files.
- Blocker found: PE worker sessions are created with empty skills (`getSkills: () => ({ skills: [], diagnostics: [] })`, PE src/workers/PiWorkerExecutor.ts:206-214; src/taskDiscipline/worker.ts:148; src/cav/vision.ts:127). Skills would only reach the operator session, not workers/reviewers, unless that policy is deliberately changed (and tested against the no-user-skills worker isolation invariant).
- Also unverified: PE currently targets Pi (minimumPiVersion 0.87.0), not OMP, so the omp-plugins provider semantics apply only after the OMP unification. Mark: UNKNOWN until tested in an OMP host.
- A skillshare lock pin is the alternative when third-party content is needed; extension skills/ is preferred for PE-owned content.

## 7. Open items for later phases
Benchmarks A/B not run (out of scope). Rollback command, registry signing, Claude/Codex semantic parity remain UNKNOWN.
