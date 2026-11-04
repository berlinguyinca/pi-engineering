# Pack amendments

`MANIFEST.json` content-addresses revision `2026-09-15-v3` of this spec pack. Two
files in this repository deviate from those hashes, both for one reason: the
OpenViking HTTP transport is retired and durable memory is **Hindsight through the
`herdr-memory` CLI** (`durable.kind: hindsight`, `PI_HINDSIGHT_*`; `openviking`
fails `resolveBlackholeConfig`). The amendments exist so an agent that reads the
pack — `IMPLEMENTATION_PROMPT.md` tells it to read the numbered specs — cannot be
sent to build a transport that no longer exists.

| File | Manifest `sha256` | Working copy `sha256` | Amendment |
| --- | --- | --- | --- |
| `specs/07-openviking.md` | `ea77bd91533fc68a3a1b3a8f192277a895730de2abb70c2e56a7e126f2709fb1` | `f1fe14311ee3239b06e92e552eacea5942704c3698fc655add107cb1b8d7eb65` | Header banner "Amended — the role is Hindsight's" above the verbatim requirement text |
| `support/EXTERNAL_TOOLS_AND_OWNERSHIP.md` | `fea8aca62c460f519eaa1cc3230f75c3361422c6a0749096a7cef375c1e8a488` | `3f0a12b25214a4f4507af87d8ac0e804f871042c3703e9dfaeef77b1d158ee0b` | The OpenViking row names Hindsight through the `herdr-memory` CLI as owner/source and forbids a second transport |

**What was *not* changed.** No requirement was weakened, removed or reworded.
`specs/07-openviking.md` keeps its normative paragraph verbatim (mandatory shared
durable memory, distinct session per parent/child over a shared project resource,
bootstrap + on-demand retrieval, boundary commits, explicit offline outbox, secret
redaction, promotion only of validated observations); the banner states which
implementation now satisfies it and that `GAP_MATRIX.md` §07 remains the scored
status. `EXTERNAL_TOOLS_AND_OWNERSHIP.md` keeps the same boundary — durable memory
stays an EXTERNAL SERVICE with a client-side integration owned here — it only
changes which external system and transport fill the role.

**Where the original bytes are.**

- `specs/07-openviking.md`: `.spec-impl/pi-engineering-implementation-spec-2026-09-15/specs/07-openviking.md`
  reproduces the manifest hash exactly (verified).
- `support/EXTERNAL_TOOLS_AND_OWNERSHIP.md`: not present in `.spec-impl/…`;
  recover it by re-fetching revision `2026-09-15-v3` and checking against
  `fea8aca6…` above.

**Do not trust `.spec-impl/…` as a pristine mirror.** Independently of this
change, six files under `.spec-impl/pi-engineering-implementation-spec-2026-09-15`
already differ from `MANIFEST.json` on `main`: `IMPLEMENTATION_ORDER.md`,
`MASTER_SPEC.md`, `prompts/IMPLEMENT.md`, `specs/02-pi-web.md`,
`specs/03-plannotator.md`, `support/DECISIONS.md`. The working copies under
`docs/specs/pi-engineering/` match the manifest for all of those; the two rows in
the table above are the only deviations there, and they are this change's.

**Reading the rest of the pack.** "OpenViking" still appears throughout
`MASTER_SPEC.md`, `IMPLEMENTATION_ORDER.md`, `support/DECISIONS.md` and section 07 of
`GAP_MATRIX.md`, and those files are deliberately left at their manifest hashes:
there the name labels the *role* - mandatory shared durable engineering memory -
not a transport. The role is filled by Hindsight through the `herdr-memory` CLI
(`durable.kind: hindsight`, `PI_HINDSIGHT_*`), which is the only supported durable
transport; `openviking` fails configuration validation, and the repository-root
`IMPLEMENTATION_PROMPT.md` instructs agents not to reintroduce the HTTP client.
GAP_MATRIX section 07 stays the scored status for the role.

**Re-derive it yourself:**

```sh
python3 - <<'PY'
import hashlib, json, os
root = "docs/specs/pi-engineering"
for e in json.load(open(f"{root}/MANIFEST.json"))["files"]:
    p = e["path"]; f = f"{root}/{p}"
    h = hashlib.sha256(open(f, "rb").read()).hexdigest()
    print("OK    " if h == e["sha256"] else "AMENDED", p)
PY
```

Expect exactly the two `AMENDED` rows above. Nothing in `src/`, `scripts/` or
`test/` reads or verifies this manifest (grep for `MANIFEST.json` finds only
unrelated manifests), so the deviation breaks no check — which is precisely why it
is recorded here rather than in a test.
