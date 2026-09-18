# Evidence Ledger Contract

Required fields: requirement_id, status, git_sha/tree, role, worker/run id, timestamps, gate type, tool/command, exit code, artifact URIs/hashes, environment/stack identity, and failure reason. Status promotion is role-gated. Implementers cannot write VERIFIED. UNKNOWN/SKIPPED never satisfy a required gate. Ledger writes must be concurrency-safe and append/audit capable.
