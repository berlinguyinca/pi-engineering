# Skills overlap matrix: OMP skills vs Pi Engineering

PE has no tracked skills, so there are no exact duplicates of OMP skill files. Overlap is functional (prompt-authoring and prompt-compression guidance) and is mapped below. PE sources @ 5ab85965; OMP @ 57263720.

| OMP skill | PE counterpart | Relation | Notes / evidence |
|---|---|---|---|
| semantic-compression | PE `src/compaction/summaryInstructions.ts` (SUMMARY_WORD_CAP 900, compaction summary) | Complementary | Different targets: PE bounds session summaries; OMP skill compresses static prompts. No shared rules. |
| semantic-compression | PE `AGENTS.md:67-83` Context Discipline, `src/workers/prompts.ts` ("Prompts stay intentionally short") | Complementary | PE shares the goal (small context) but prescribes structure not register; skill could compress worker prompts/handoffs (Exp A). Skill step 0 density gate and "never compress ledger evidence" align with PE evidence discipline. |
| system-prompts | PE `src/lifecycle/rolePrompts.ts`, `src/workers/prompts.ts`, `src/plannerWorker/prompts.ts`, `src/visionDelegation/rolePrompt.ts` | Complementary, partial style conflict | OMP prescribes tags (`<critical>`, `<workflow>`), RFC-2119 caps and imperative second person. PE prompts use plain prose ("Never invent a file path", "Reporting nothing is a valid outcome"). Adopting tags would rewrite prompts and require re-baselining of tests (review-citation-gate, workers). |
| system-prompts (Tone Patterns) | PE `AGENTS.md:67-83` and global context hygiene | CONFLICT if adopted verbatim | "Anti-budget framing: You NEVER narrate about or even consider session limits, token/tool budgets" contradicts PE Context Discipline and the 50% context warning. Reject that pattern. Also "Identity overrides... user's own override prior" is neutral. |
| system-prompts | PE `AGENTS.md` Operating Mode ("Recommendation equals action") | Neutral | PE policy is operational, not prompt-authoring. No conflict with RFC keywords. |
| system-prompts small-models.md | PE small-model work (qwen loop reliability specs in docs/specs) | Complementary, UNKNOWN fit | Not evaluated; Exp B/A at 60k/100k/120k pending. |
| tool-prompt-optimization | PE `registerTool` sites (4) and command descriptions in extensions/index.ts | Complementary | Probe scripts need OMP monorepo packages; method-only reuse. |
| (all three) | PE `/engineer /review /verify /plan /execute` commands | None | Skills are `/skill:<name>` namespace; no collision with PE commands. |
| auto-learn/managed skills | PE ledger/Hindsight/`/remember`, `/memory` (src/blackhole/interactiveMemory.ts) | CONFLICT risk | OMP `learn` writes to a separate memory backend and creates skills: parallel memory store; spec ownership says Hindsight owns durable facts. Keep auto-learn off. |
| Skillshare registry/lock | PE package-lock.json + extension packaging | Overlap in function (pinning) | Prefer extension `skills/` + npm pin for PE-owned content; skillshare only for third-party. |

Exact duplicates: none. Conflicting instructions: 2 (anti-budget tone; auto-learn vs ledger/Hindsight ownership). Mark UNKNOWN: overlap with the maintainer's private skills and registry skills.
