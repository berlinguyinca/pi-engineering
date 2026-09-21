# Detailed implementation order

1. Reconcile current Pi Engineering and InferWeave code against these specs. Reuse existing orchestration, reviewers, worktrees, browser testing, MCP, metrics and routing.
2. Shared schemas and migrations.
3. InferWeave capability registry + MCP task execution.
4. Pi repository/UI discovery + impact classifier.
5. Evidence capture + deterministic metrics.
6. Rubric engine + persistence/history.
7. Design exploration + diffusion mockups.
8. UI genome extraction/enforcement.
9. Runtime usability/exploration/responsive/adversarial/temporal tests.
10. Independent reviewers.
11. Root-cause/cause attribution + generated implementation specs.
12. Candidate tournaments.
13. Pareto gates.
14. Autonomous controller.
15. pi-web surfaces.
16. Shadow/advisory/autonomous staged rollout.

For every step: add unit/integration/end-to-end tests, structured logs/metrics, failure handling, configuration, docs and rollback. Do not merely scaffold.
