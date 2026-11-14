# Skill security review (untrusted content)

Method: static read only. All skill text treated as DATA. Nothing executed, installed, or fetched. Scope: 3 tracked OMP skills + small-models.md + 2 scripts, plus the installer/auto-learn paths. Private/registry skills not inspected (UNKNOWN).

## Content checks
- Hidden characters: PCRE scan for zero-width, bidi and BOM code points across `.omp/skills` found none.
- Prompt-injection phrases (ignore previous, system override, exfiltrate): none found in skill bodies. Instruction-shaped text exists only as normal style guidance (MUST/NEVER). One notable behavioral directive set: system-prompts "Tone Patterns" (anti-budget framing, persistence, "instructions further down ALWAYS override prior") would alter agent behavior if loaded into PE sessions; treat as policy-affecting, review before adopting.
- semantic-compression asserts the `omp compress` command is isolated and nonce-quoted (source declared inert). That is a claim in the text; we did not verify the code path (src/compress/session.ts passes `skills: []`, consistent with the claim at line 58).
- No embedded network URLs, base64, curl/eval, or credentials in SKILL.md files (grep for curl/eval/base64 hit only prose mentions of `cat/curl/tar` as tools to avoid).

## Executable content
- tool-prompt-optimization/scripts/probe.ts (225 lines) and probe-builtin.ts (158): TypeScript run via `bun`. Imports are limited to node:util, @oh-my-pi/pi-ai, pi-catalog. No child_process/spawn/fetch found. Risks: sends tool schema/prompt text to external LLM providers using FIREWORKS/ANTHROPIC/OPENAI keys from the environment (cost + data egress); `probe-builtin.ts` instantiates live tools from OMP internals (side effects unreviewed: UNKNOWN). Recommendation: do not run without explicit approval, with a no-key/--show dry path first (`--show` exits without API calls per SKILL.md).
- No other executable files in the 3 skills.

## Infrastructure risks
1. Skill script execution: discovery loads any skill; scripts run only if the agent invokes bash. The user-invocation prompt tells the agent to resolve relative scripts against the skill directory (prompts/skills/user-invocation.md, per docs/skills.md). PE needs policy: no auto-run of skill scripts without approval.
2. Registry TOFU: first install trusts skills.omp.sh bytes; SHA-512 lock gives reproducibility only. `http://` registry URLs allowed (client.ts:88-90). Script-bearing installs need confirmation, `--yes` bypasses it (installer.ts:296-304,623).
3. Auto-learn: agent-written skill bodies persist globally with no review gate (see skills-infrastructure.md section 5). Lesson text is sanitised/redacted, but skill body instructions are not. Prompt-injection from untrusted tool output could therefore persist as a standing instruction. Mitigation: keep `autolearn.enabled=false`; add PE promotion gate.
4. Cross-provider discovery widens the attack surface: `.claude/skills`, `.agents/skills`, `.github/skills`, `.opencode/skills` in a cloned repo are loaded by default at project level (claude project default true, agents project default true; extensibility/settings.ts:47-66). A malicious repo can ship skills that appear in the catalog. Mitigations: `skills.ignoredSkills`/`includeSkills`, `manualSkills`, per-provider toggles.
5. Path safety (positive): `skill://` rejects absolute paths and `..` and realpath-checks containment for registry/agent-plugin skills (docs/skills.md "skill:// URL behavior"; test/skill-url-containment.test.ts). Frontmatter name with `/` or `\` rejected.
6. PE worker isolation: PE workers get no skills (PiWorkerExecutor.ts:206-214). This is protective; changing it expands the untrusted-instruction surface of reviewers/verifiers.

## Verdict
No malicious or hidden content found in the 3 tracked skills. Risks are structural (scripts with paid-provider calls, auto-learn persistence, project-level foreign skill dirs, registry TOFU). Adoption of any skill requires: pin by blob/commit SHA (recorded in skills-inventory.csv), license check (repo MIT; per-skill license not declared), and human review of the loaded text.
