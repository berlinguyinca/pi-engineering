# Policy model and default matrix

| Operation | Investigation | Implementation | Review | Deployment |
|---|---|---|---|---|
| Read project code / related repos | allow within permitted read roots | allow | allow | allow relevant |
| Read local logs and diagnostic samples | allow within permitted roots | allow | allow | allow |
| Local test execution | permit explicitly classified safe tests | allow scoped | allow scoped | allow specified preflight |
| Write scoped project files | deny | allow | deny by default | deny unless specified |
| Write outside scoped project | deny | require approved expansion | deny | deny |
| Git commit locally | deny | allow when contract allows | deny | specified |
| Git push / CI trigger | deny | deny by default | deny | approved targets only |
| Upload artifacts, scp/rsync, SSH write | deny | deny by default | deny | approved targets only |
| Deploy / restart remote services | deny | deny | deny | approved targets only |
| Delete data / destructive DB | deny | deny by default | deny | separately privileged approval |
| Connect unknown remote hosts | deny | deny by default | deny | deny |

**Defaults, not exhaustive:** local tests can have side effects, so inspect/effect-classify/sandbox. Commands `curl`, `ssh`, `rsync`, `scp`, `git push`, pipes, redirection, wrapper scripts, Makefile targets and CI helpers cannot be approved solely by first token. Remote read access is not globally granted. Task mode != all-access role.

**Decision algorithm:** trusted task contract -> identify tool adapter and actual capability -> normalize resources and effect -> validate policy/approval state -> allow, deny, or require human-approved amendment -> log decision -> only then execute. Concurrency: approvals bound to contract revision, tool-call hash, target/effect and expiry; stale/changed requests revalidate. Prevent TOCTOU by enforcement at real capability boundary where feasible. For unknown effects, block until safely classified. No implicit automatic approval by model/monitor.

**Error recovery:** on deny, preserve session, inject explanation and authorized next actions; do not retry variant transport. If >3 similar blocks within rolling task segment, halt agent action loop and surface a policy incident. When no safe path exists, finish with blocker and request explicit user scope change.

**Protection layers:** Pi preflight + individual adapter validation + container OS isolation/file permission/network egress when appropriate. Document unguarded edge cases. Never call a semantic LLM reviewer a security boundary.
