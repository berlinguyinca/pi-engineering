# Strict handoff protocol

## State machine
`PENDING -> BASE_VERIFIED -> RUNNING -> CANDIDATE -> VERIFIED -> AWAITING_OPERATOR_APPROVAL -> APPROVED -> NEXT_TASK`
Failure at any point: `BLOCKED` with preserved worktree, command logs and trace. `ALREADY_SATISFIED` also requires evidence and approval. No auto-retry.

## Inputs verified before EVERY task
- Exact task id and spec version; task is the only next ID in the manifest.
- Complete predecessor handoff and approval, with its SHA256 hash verified; previous artifact hashes match.
- Current repo clean HEAD matches approved base SHA. For cross-repo transitions, independently obtain target HEAD and use that as `nextBaseSha`; do NOT use SHA of prior repo.
- User request authority hash unchanged. No expanded allowlist, diff budget, or verification target.
- Actual repo paths/seams exist or the task is explicitly creating a new file.

## Outputs required
Write one JSON handoff matching `templates/handoff.schema.json`. For canonical handoff hashing: serialize JSON using deterministic sorted keys and UTF-8, **excluding the `handoffHash` field itself**; compute sha256 over the serialized bytes. Store adjacent immutable test logs and git diff evidence by sha.

## Ownership and trust boundaries
- Task worker may propose candidate files and handoff evidence, but must not set `operatorApproval.approved=true` itself.
- Independent validator recomputes file lists, SHA, line budgets, and test exit codes. The operator authorizes the next task.
- Handoff hash detects accidental modification; without a signer it is **not cryptographic authorization**. Operator approval must be held outside a model-writable directory, ideally through a trusted local command.
- Keep failed attempts; do not silently overwrite previous state.
- When already satisfied, require source-path proof and passing verification, not just model text.
- Never interpret failure to read a required artifact as permission to continue.

## Handoff visibility
Show task objective, changed files, tested behaviors, model identity/quantization, context consumed, first off-scope event and next exact objective. Do not pass full preceding conversation into worker contexts.
