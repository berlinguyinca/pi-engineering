# Pi Engineering Brownfield Audit & Remediation Pack

Purpose: extend the implemented CAV system so existing repositories can be reconstructed from historical specs, audited against source and real runtime behavior, baselined, clustered by root cause, and repaired in dependency-ordered campaigns without trusting historical implementation claims.

## Mandatory sequence
1. Pi Engineering dogfood audit
2. Generic brownfield audit engine
3. Requirement reconstruction and provenance
4. Source/runtime mapping
5. CAV evidence execution
6. Baseline preservation
7. Defect/root-cause clustering
8. Repair campaign planner/executor
9. AIMS profile and pilot
10. InferWeave profile and pilot
11. WeaveForge profile and pilot
12. Hardening and default automatic activation

Every later phase depends on VERIFIED exit gates from prior phases. UNKNOWN, SKIPPED, PARTIAL, BLOCKED, or historical claims are not VERIFIED.

See MASTER.md, ROADMAP.md, contracts/, profiles/, and steps/.
