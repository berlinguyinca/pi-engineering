# Fleet runtime maintenance

HerdR Engineering coordinates fleet upgrades. Pi Engineering executes local,
typed maintenance operations in the live process that owns a mission. Installing
files, displaying a note, and accepting a command are distinct from completing
an upgrade or recovering a mission.

## Inventory and provenance

`pi-engineering sessions list --json` returns live control descriptors and status.
The `runtime` field reports the actual loaded runtime commit and generation, the
stable Host commit captured at bootstrap, supported capabilities, and a pending
handover flag. An absent runtime field means maintenance cannot be verified.

Mission inventory covers custody held by this process across its opened workspace
bindings, including missions reclaimed after a cold process restart. Creator
session IDs and a shared repository snapshot do not grant custody. Each mission
includes its current revision, resumption generation, operator pause state,
resume eligibility, progress timestamp, and any named recovery wait.

## Structured commands

The same-user Unix socket supports the version-1 `maintenance` operation in
addition to `ping`, `status`, and informational `note`. The CLI sends JSON without
opening another Pi model session:

```sh
pi-engineering sessions maintenance INSTANCE_ID --request-json '{"operationId":"rollout-prepare-1","action":"prepare","expectedInstanceId":"INSTANCE_ID","timeoutMs":30000}'
```

Use an exact instance ID from discovery. Actions are `describe`, `prepare`,
`reload`, `resume`, and `status`. `reload` additionally requires an exact
`expectedCommit` and may name an absolute staged `sourceRoot`. `resume` requires
`expectedCommit`, `missionId`, `expectedRevision`, and
`expectedResumptionGeneration`. `status` polls a previously accepted operation ID.
Requests reject unknown fields, invalid identifiers, and mismatched targets.

The reply contains a maintenance receipt whose status is `running`, `succeeded`,
`failed`, or `skipped`. A running receipt proves acceptance only. Poll until a
terminal receipt exists, then independently verify loaded code and mission
progress. The CLI prints JSON for failed receipts and returns exit code 1.

## Persistence and replay

Receipts are private files under `PI_ENGINEERING_STATE_DIR/maintenance`, or the
usual local state directory when no override is configured. A receipt is claimed
and synchronized before executing side effects. Reusing its operation ID with
different arguments fails. Completed operations are replayed without executing
again. Mutating commands for one conversation exclude each other across
controllers and runtime generations using the existing process-incarnation lock.

A process that dies before completing a receipt leaves an uncertain operation.
It is reported for reconciliation rather than automatically repeating a possible
mission resumption. A new runtime instance may query the original receipt using
the same conversation and operation ID. Do not delete receipts to force retries.

## Drain, activate, and resume

Preparation prevents new local mission dispatch and drains worker phases that
support resumable cancellation. It checkpoints and durably pauses the existing
mission with a maintenance reason. Planning, integration, publication, and other
critical phases return `busy` until safe; they are never force-killed. The default
safe-point wait is 30 seconds. Activation verifies an immutable selected Git
commit and healthy replacement generation before reporting success. A failed
handover retains the prior generation and does not consume that source commit
as successfully reloaded.

Automatic resumption checks current custody, loaded code, revision, resumption
generation, and latest operator intent. It never clears an operator pause or
creates another mission. The durable resumption write uses a conditional append
so a concurrent pause, cancellation, or newer resumption wins. Terminal missions
and unresolved operator decisions remain preserved.

Runtime reload cannot replace the stable Host code. Sessions lacking the control
capabilities, or requiring a Host fix, need controlled extension/process bootstrap
with their exact conversation identity and preserved work. The fleet coordinator
reports this as `bootstrap_required`; it does not invent success or kill sessions.

Recovery waits use production supervision to probe and redispatch existing work.
An explicit operator stop remains separate from an infrastructure wait. A stale
dispatch authority cannot adopt a replacement epoch, and authority loss leaves
unfinished tasks resumable rather than canceled.
