# Hindsight memory: why automatic recall was silent, and what fixed it

Status: implemented on `fix/hindsight-recall-delivery-v2`, base `origin/main@0ee44711`.
Live evidence below is from macOS with `~/.local/bin/herdr-memory` against project
`canary` on 2026-11-04. Read-only: no memory was written or deleted.

## The symptom

With memory on by default, `pi -p` sessions answered questions about recorded facts
as though the bank were empty. Nothing was logged as broken; the footer said
`Memory: ready · 0 recalled`.

## Three independent causes

1. **The turn budget was below the client's floor.** `automatic()` raced every lookup
   against 250 ms. One `herdr-memory recall` over a real bank measures **0.4–4.9 s**
   (warm 390–1500 ms, cold 3.2–4.9 s), so automatic recall could only ever time out.
2. **A timed-out lookup injected nothing.** The `context` hook injected `recalled`
   when non-empty and stayed silent otherwise, so the model saw an ordinary turn with
   no notes and reported "no records" — a different claim from "the bank could not be
   read".
3. **The readiness probe asked a question the service refuses.** `probe()` and
   `recallAll()` ran `recall "*"`. There is no list endpoint and a wildcard is
   rejected: `{"error":"Memory service rejected request (HTTP 422)"}`, exit 1 (an
   empty query fails client-side). So every session started with a failed probe,
   which put automatic recall into the failure backoff before the first prompt —
   the bank looked empty even with a healthy service and a generous budget.

Cause 3 is the one that survives a budget bump, and it is why the failure looked like
a policy problem rather than a wire-contract problem.

## What changed

| Surface | Before | After |
| --- | --- | --- |
| In-turn budget | 250 ms, hardcoded | `memory.hindsight.automatic_recall_ms`, default **1200** (100–5000) |
| Headless (`pi -p`) | 250 ms | **5000 ms** — no spinner, and its single model call is the only chance to carry memory |
| Readiness probe | raced at 250 ms | **5000 ms**, paid once per session (`readinessDone`), so a healthy-but-slow client stops reporting "timed out" |
| Overview read | `recall "*"` → HTTP 422 | bounded `OVERVIEW_QUERY` (`project memory decision`); counts built on it are a probe, never a total |
| Budget miss | turn proceeds in silence | one `pi-engineering-memory` notice: *"could not be read this turn … treat it as unavailable, not empty"* |
| Late answer | discarded | adopted by the **same** turn's next `context` emit; fenced by turn counter, lookup epoch and session generation |
| Backoff after a timeout | 60 s | `min(failure_backoff_ms, 10 s)` — slow is not broken |
| CLI subprocess on a miss | killed at the turn budget, which also paused the provider | outlives the turn (`max(timeout_ms, budget)`); the turn is bounded by the hook's race, not by killing the read |

Two details are load-bearing and easy to undo by accident:

- The interactive hook must **not** pass `deadlineMs` to `search()`. That provider path
  answers a deadline miss with an empty list — indistinguishable from an empty bank —
  and pauses the provider, which is how a slow client became "0 recalled" instead of a
  timeout.
- `clearRecall(retirePending)` keeps this turn's own lookup alive on the automatic
  failure path. An explicit command or a new turn still retires pending work through
  the epoch.

## Live verification (macOS, `~/.local/bin/herdr-memory`, project `canary`)

| Run | Result |
| --- | --- |
| Headless, default budgets | readiness 398 ms, turn 385 ms, one `pi-engineering-memory` block of **4213 bytes** of `canary-facts` records in model context |
| Interactive, healthy client, default budget | readiness 288 ms, turn 556 ms, 4213 bytes delivered |
| Interactive, client delayed 1.2 s, `automatic_recall_ms: 200` | turn 205 ms → **232-byte notice** ("could not be read this turn (herdr-memory timed out)") |
| Interactive, client delayed 1.2 s, default budget | turn 1206 ms → notice; the next model call of the **same** turn carries **4213 bytes** once the client answers |
| `cli: /nonexistent/herdr-memory` | 283-byte notice naming the client, not a host or key |

## Tests

- `test/unit/interactive-memory.test.ts` — in-turn budget, headless-waits-longer,
  late-answer-adopted, late-answer-fenced-by-next-turn, wedged client bounded and not
  re-probed, and that a failed read injects the notice instead of nothing.
- `test/unit/hindsight-memory.test.ts` — the overview reads never send a wildcard; a
  hung client produces the notice.
- `test/unit/hindsight-settings.test.ts` — `automatic_recall_ms` in the YAML surface.

## Second pass: counts, the write path, and workers (2026-11-05)

Probing the service's own surface (read-only, plus argument-shape probes that persist
nothing) turned up four more contract facts.

**`documents` is the list endpoint, and it is the only honest count.**
`documents --kind fact --scope project --limit 1` answers
`{"bank_id":"canary-facts","total":28,"total_is_estimate":false,…}`. `--kind` selects
fact-vs-summary, not the record kind (the rows carry `kind: preference`, `verified`, …).
`probe()` now sums that per configured scope and falls back to the overview recall only
when no list count can be trusted (`total_is_estimate` true, refused scope, older client).
Live: `["project"]` → 31, `["project","global"]` → 34, 250–290 ms for both scopes in
parallel. So `/memory`'s "N saved" is the bank's size, not a recall sample.

**The evidence gate is real and pi satisfies it.** `retain` without `--evidence` answers
`{"error":"Durable facts require explicit save intent or evidence references","outcome":"rejected"}`.
`/remember` satisfies it with `--evidence user-request:<uuid>`; pi never passes
`--explicit`, which the message offers as the alternative.

**`forget` is not a confirmation.** A tombstone for an id the service has never seen is
accepted: `forget mem-0000…` → `{"state":"delivered","outcome":"persisted",…}`, exit 0.
So `HindsightDurableMemory.forget()` returning `true` means "delivered", never "a memory
was deleted". `get <id>` distinguishes the states (`{"error":"Memory not found"}`, exit 1),
which is what a future `/forget` command must consult before it claims anything — recorded
on `forget()` itself, because there is no caller to fix yet.

**`correct` takes `memory_id text --evidence …`** as pi sends it; an unknown id answers
`{"error":"Memory not found","outcome":"rejected"}`.

**Worker hydration's cap was unreachable, so workers never got memory.**
`HYDRATE_CAP_MS` was 250 ms against a 0.4–4.9 s client, and the deadline path also pauses
the provider — so the first slow read silenced memory for a minute per process. It is now
1200 ms, matching the interactive in-turn budget, and still bounded and fail-open.

## Write path: proven end to end (2026-11-05)

No sandbox project could be provisioned (`--project pi-write-probe` →
`{"error":"Unknown configured project"}`; projects and per-harness credentials are
server-side), so the round-trip ran against `canary-facts` with one self-describing,
clearly-marked record and was verified gone afterwards — the record is not recallable and
the bank total is back to the pre-probe 31. Driven through `HindsightDurableMemory` itself,
so it is pi's argv under test, not the CLI's help text.

| Step | Live answer | pi's parse |
| --- | --- | --- |
| `retain <text> --scope project --provenance {…} --evidence probe:<uuid>` | `{"state":"delivered","outcome":"persisted","memory_id":"mem-0ce8…","bank_id":"canary-facts","revision":1}` | `persisted` + id + bank + revision ✓ |
| `get mem-0ce8…` | text byte-identical, `status: verified`, `revision: 1`, `kind: fact` | write is synchronous, not outbox-delayed ✓ |
| `recall "WRITE-PATH PROBE 20261105"` | record present among 11 verified hits | searchable immediately ✓ |
| `correct mem-0ce8… <text> --evidence probe-correct:<uuid>` | `outcome: persisted`, `revision: 2`, `supersedes_revision: 1` | revision 2 ✓ |
| `forget mem-0ce8…` then `get` | `outcome: persisted`, then `{"error":"Memory not found"}` exit 1 | deleted for real ✓ |

Two things this settles and one it sharpens:

- `retain` does not need `--explicit` when `--evidence` is present, and the write is
  readable by the next call — no outbox wait to design around.
- A record retained without `--kind` lands as `kind: fact`, `status: verified`.
- The tombstone gap is narrower than it looked: deleting an id that exists really deletes
  it. What `forget()` cannot say is *which* happened, because an unknown id answers the
  same `outcome: persisted`. A `/forget` command still needs the `get` pre-check; ordinary
  deletion does not.

## Not covered here

- Nothing on the memory surface is unproven against the live service as of 2026-11-05.
  The write round-trip above closed the last gap.

## Per-host provisioning runbook (2026-11-17)

Engineering memory is provisioned **per host**, and nothing on the memory surface
fails loudly when a host was never provisioned — a missing client degrades to "no
memory". This runbook is the single place a pi-engineering operator provisions a new
host end to end. It covers pi-engineering issue #673.

### 0. What "provisioned" means

A host is provisioned when all four are true:

1. the `herdr-memory` CLI is installed **at the pinned revision**;
2. `~/.config/herdr-memory/config.json` exists, names the correct endpoint, and sets
   `tenant` to a **server** tenant name (see the trap below);
3. the tenant credential files are readable and `0600` inside a `0700` parent, and no
   `personal`-tenant key was ever exported to this host;
4. the project/global/infra banks exist (recall is always the first call, and a
   never-written bank 404s).

After provisioning, `herdr-eng memory doctor` and `herdr-memory --harness pi status`
should both pass (the only expected non-OK doctor line is `UNKNOWN fleet_update`, which
is the unrelated herdr-memory#7).

### 1. Install the pinned client

The pin is owned by the herdr-engineering adapter (`memory_install.PINNED_REVISION` in
the `herdr_engineering` package), and `herdr-eng memory doctor` enforces it. Install the
CLI at that pin with `uv tool`:

```sh
uv tool install "herdr-memory @ git+ssh://git@github.com/berlinguyinca/herdr-memory.git@d48b334b6236065aa188a696dc6e9095b04ca761"
```

Verify:

```sh
command -v herdr-memory   # ~/.local/bin/herdr-memory (or a venv on PATH)
herdr-eng memory doctor   # OK pin / OK package_revision / OK client_version
```

`herdr-eng memory install` installs the harness **adapters** only; it does **not** install
the `herdr-memory` package itself. If `command -v herdr-memory` is empty, every adapter
and the pi provider spawn a nonexistent binary and memory is silently never seen.

### 2. Write the config (and the tenant trap)

`~/.config/herdr-memory/config.json` (mode `0600`):

```json
{
  "url": "https://memory.local.metabolomics.us",
  "timeout_seconds": 10,
  "default_project": "pi-engineering",
  "projects": {
    "pi-engineering": {
      "tenant": "project",
      "mission_scopes": true,
      "paths": ["/home/<user>/pi-engineering"],
      "credentials": { "pi": "~/.config/herdr-memory/tenants/project.key" }
    }
  },
  "scopes": {
    "global": { "credentials": { "pi": "~/.config/herdr-memory/tenants/global.key" } },
    "infra":  { "credentials": { "pi": "~/.config/herdr-memory/tenants/infra.key" } }
  }
}
```

**The tenant trap.** The client (`client.py`) does `tenant = tenant or project`, and the
namespace is `sha256([url, project, tenant])`. The deployment's server tenants are named
`project` / `global` / `infra`. So a config with a `projects."pi-engineering"` entry and
**no explicit `tenant`** authenticates against tenant `pi-engineering` — a name that does
not exist server-side, and `doctor` will not catch it. `tenant` must always be set to the
**server** tenant name (`project` here), never the project slug.

### 3. Credential files

Export each tenant's key into `~/.config/herdr-memory/tenants/` (the parent must be
`0700` and each key `0600`):

```sh
herdr-eng fleet config memory export-key project --out ~/.config/herdr-memory/tenants/project.key
herdr-eng fleet config memory export-key global  --out ~/.config/herdr-memory/tenants/global.key
herdr-eng fleet config memory export-key infra   --out ~/.config/herdr-memory/tenants/infra.key
chmod 0700 ~/.config/herdr-memory/tenants
chmod 0600 ~/.config/herdr-memory/tenants/*.key
```

Never export a `personal`-tenant key to a project host, and never loosen permissions:
`herdr-eng memory doctor` fails the `credential:…` checks if a key is group/other
readable or its parent is world-accessible.

### 4. Endpoint routing

The fabric route **from `beast`** is `https://memory.local.metabolomics.us`. Do **not**
use `memory.dev.lan` (port 8897) — that is `bender`-only and not routable from `beast`,
and the client refuses plain `http://` off loopback. The fleet-config cache served to a
host may have no `sections.memory` slice yet, so `discover_endpoint()` cannot supply the
URL; set it explicitly in the config as above.

### 5. Provision the banks (explicit PUT)

Banks are created implicitly on first **write**; recall — always the first call — 404s on
a never-written bank (berlinguyinca/herdr-memory#17). Create the four banks explicitly
with the server credential before first recall:

```
PUT /v1/default/banks/pi-engineering-facts
PUT /v1/default/banks/pi-engineering-summaries
PUT /v1/default/banks/herdr-global
PUT /v1/default/banks/herdr-infra
```

### 6. Verify

```sh
herdr-eng memory doctor                       # all OK except fleet_update
herdr-memory --harness pi status              # {"healthy":true,"auth_ok":true,…}
pi -p -e 'what did we record about <topic>?'  # memory block present, not "0 recalled"
```

### Failure taxonomy: `not-installed` vs `unavailable`

`HindsightDurableMemory.call` classifies spawn failures instead of collapsing them:

| Code | Meaning | Backoff |
| --- | --- | --- |
| `not-installed` | spawn `ENOENT`: the CLI is absent from this host (never provisioned) | `failure_backoff_ms` (60 s) — re-probes so a provisioning fix is noticed |
| `unavailable` | config missing/invalid, or the service is unreachable | `unavailable_backoff_ms` (300 s) |
| `timeout` | the subprocess was killed at its per-call deadline | `failure_backoff_ms`, capped at 10 s |
| `exit` / `response` | non-zero exit, or unreadable output | `failure_backoff_ms` |

A `not-installed` host stays fail-closed (reads degrade to "no memory"), but is reported
loudly and re-probed on the short failure backoff rather than being hidden behind the
300 s unavailable pause.

### Preflight: "not provisioned" vs "slow read" (2026-11-18, #717 with #673 ask 3)

The failure taxonomy above classifies *one call*. It cannot answer the question an operator
actually asks — "is this host provisioned, or was memory just slow this turn?" — because a
timeout is evidence about the call, not about the host. Measured on this deployment:
steady-state recall 0.28–0.42 s, the cold spike recorded above 4.06 s (~13x apart), and
8-way contention moves it by ~10% (331 ms vs 302 ms idle). So "timed out" was never
information about provisioning, yet it printed as if it were.

Two modules, one set of checks, so the two surfaces cannot disagree about the same host:

- `src/blackhole/memoryPreflight.ts` consults `herdr-eng memory doctor --json` — the checks
  herdr-engineering owns, because that package owns the pin and the credential layout — and
  renders them for `/engineering version`. It deliberately does **not** re-implement them.
- `src/blackhole/memoryProvisioning.ts` adds what doctor does not cover: the client the
  runtime actually spawns (`herdr-memory`, not the wrapper) and whether each configured
  scope resolves to an engineering bank. It asks doctor through the module above instead of
  spawning it a second time, then turns the whole set into the verdict `/memory status` and
  the failure notices print.

| Check | Call | Proves |
| --- | --- | --- |
| `client` | `herdr-memory --version` | the binary the runtime talks to exists, and what it says its client/contract is |
| `config` | `herdr-memory validate-config` | the CLI's own config parses (nothing called this before) |
| `pin`, `package_revision`, `client_version`, `credential:<scope>:<harness>`, `server`, … | `herdr-eng memory doctor --json` | the pinned revision, credential readability + private permissions, reachability |
| `bank:<scope>` | `herdr-memory documents --kind fact --scope S --limit 1` | the scope resolves to an engineering bank, i.e. section 5 above ran |

`fail` means **retrying will not fix this** (missing binary, unusable config, refused
credential, missing bank) and sets `provisioningGap`. `warn` means the check learned nothing
— including nothing about the host being broken — so a slow host is never reported as an
unprovisioned one. Doctor's own `warn` (measured 2026-11-18: `package_revision`, when the
installed client revision drifts from the pin) stays a warning: it is "not what was
expected", and turning it into a failure would tell an operator to provision a host that is
already provisioned. A status outside doctor's vocabulary still maps to `fail`, so a contract
change we cannot read never reads as healthy.

Three things follow from that separation, and each is pinned by a test:

- A host with `herdr-memory` but without the `herdr-eng` wrapper **warns**. Memory is
  provisioned; only the credential checks did not run. Failing there would send the operator
  to install a client that is already installed.
- A client that will not answer `--version` is present but wedged: neither "install it" nor
  "everything is fine". The report says `inconclusive` and `/memory status` says nothing
  failed *and* nothing answered.
- Checks run cheapest first and stop after a missing binary, because every later check would
  report the same absent executable and read like four problems. A `deadlineMs` ceiling stops
  the run mid-way and prints one `budget` line instead of hanging a session start.

The client version is reported, never compared against a pin here: the pin lives in the
install script, and a second copy would rot and then lie. The checks and their contracts are
pinned in `test/unit/memory-provisioning.test.ts` (fixtures recorded from the real tools, plus
one case that runs against the real binaries when this host has them).

Where the operator sees it:

- `/engineering version` prints a `Memory preflight:` section, one line per doctor check —
  binary present and version matching the pin, managed config valid, credential files `0600`
  in a `0700` parent, server reachable. Consulted **on demand** when the command runs, not at
  session start: doctor contacts the live service (~1.35 s measured), too slow to block
  startup. The render is reused for 60 s (`MEMORY_PREFLIGHT_TTL_MS`). Every failure path is
  fail-closed — a missing `herdr-eng`, a timeout, a non-zero exit or unreadable output each
  render as one `UNAVAILABLE` line and never break the command or session start. When
  `memory.hindsight.enabled` is false the section says `disabled`.
- `/memory status` prints the connection probe plus one line per check and a verdict line:
  `Every check answered — nothing to install or configure on this host.`, or
  `Failing checks: …  Fix them … — retrying will not.`, or — when some checks could not
  answer but none failed — `No provisioning gap found … N check(s) could not answer: …`.
  One composed answer per command, including headless.
- A failed automatic read or `/memory <query>` adds one explanation per memory host per
  episode (5 min, `PREFLIGHT_EXPLAIN_MS`): either
  `Memory is not provisioned on this host: <first failing check> Retrying will not fix that.`,
  or `Memory is provisioned and reachable — no preflight check found a gap. The read that just
  failed was slow or transient, so memory retries on its own.` (naming the checks that did not
  answer, so "reachable" never means more than the checks proved), or the inconclusive sentence
  telling the operator to run `/memory status` when the host is quieter.
- Headless uses the same once-per-day telemetry channel as the failure notice, under the keys
  `memory:preflight:not-provisioned`, `memory:preflight:slow` and
  `memory:preflight:inconclusive`, so print-mode transcripts stay clean.

A settled read clears the episode, so the next failure explains itself again. A background
preflight is bounded by `PREFLIGHT_BUDGET_MS` (4 s): nobody asked for it, and a service that
is not answering must not be hammered by four more spawns.

```
$ herdr-eng memory doctor --json --harness pi   # rendered by /engineering version
Memory preflight: warn (18 checks, 1 warning)
  OK      config:pi:skill  managed config valid
  OK      pin  adapter pin d48b334b6236065aa188a696dc6e9095b04ca761
  WARN    package_revision  herdr-memory f3a20bae5fb9 != pin d48b334b6236065aa188a696dc6e9095b04ca761
  OK      client_version  client 0.1.8
  UNKNOWN fleet_update  no unattended fleet update has recorded a run
  OK      credential:project:pi-engineering:pi  0600 file in 0700 parent
  OK      server  healthy
  …
```
