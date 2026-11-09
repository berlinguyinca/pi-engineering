import json, os, re, copy, sys

R = "docs/specs/harness-reliability-bootstrap-20261103"  # run from the repo root
NEG = ("out-negctl", "out-noparent", "out-tampered")


def rank(g):
    t = {"out-chain": 5, "out-final": 4, "out-corrected": 3, "out": 1}
    if g in t:
        return t[g]
    if any(g.startswith(p) for p in NEG):
        return 0.5
    return 2 if g.startswith("out") else -1


OLD = re.compile(r"^[A-Z]{1,4}-?\d{1,2}$")
NEW = re.compile(r"^[A-Z][A-Z0-9]*(-[A-Z0-9]+)?$")
dirs = [d for d in sorted(os.listdir(R)) if os.path.isdir(os.path.join(R, d))]


def isunit(n, old):
    if old:
        return bool(OLD.match(n))
    return bool(NEW.match(n)) and any(c.isdigit() for c in n)


def load(units):
    recs = []
    for u in units:
        gens = sorted(
            [x for x in os.listdir(R + "/" + u) if os.path.isdir(R + "/" + u + "/" + x) and rank(x) >= 0],
            key=rank,
            reverse=True,
        )
        for g in gens:
            for f in sorted(os.listdir(R + "/" + u + "/" + g)):
                if f.endswith(".json"):
                    recs.append(
                        {
                            "unit": u,
                            "gen": g,
                            "file": "%s/%s/%s/%s" % (R, u, g, f),
                            "rec": json.load(open("%s/%s/%s/%s" % (R, u, g, f))),
                        }
                    )
    return recs


def analyze(recs):
    canon = {}
    for u in sorted({r["unit"] for r in recs}):
        gens = sorted({r["gen"] for r in recs if r["unit"] == u}, key=rank, reverse=True)
        ch = [g for g in gens if not any(g.startswith(p) for p in NEG)]
        if ch:
            canon[u] = next(r for r in recs if r["unit"] == u and r["gen"] == ch[0])
    bykey = {}
    for r in recs:
        bykey[r["rec"]["taskId"] + "@" + r["rec"]["baseSha"]] = r
    isC = lambda r: canon.get(r["unit"], {}).get("file") == r["file"]
    bad = [
        "%s/%s -> %s@%s" % (r["unit"], r["gen"], r["rec"]["nextTaskId"], r["rec"]["nextBaseSha"][:12])
        for r in recs
        if r["rec"].get("nextTaskId")
        and isC(r)
        and (r["rec"]["nextTaskId"] + "@" + r["rec"]["nextBaseSha"]) not in bykey
    ]
    named = set()
    for r in recs:
        if isC(r) and r["rec"].get("nextTaskId"):
            named.add(r["rec"]["nextTaskId"] + "@" + r["rec"]["nextBaseSha"])
    orph = [
        "%s/%s %s@%s" % (r["unit"], r["gen"], r["rec"]["taskId"], r["rec"]["baseSha"][:12])
        for r in canon.values()
        if (r["rec"]["taskId"] + "@" + r["rec"]["baseSha"]) not in named
    ]
    return canon, bykey, bad, orph


# --- the six corrected generations this unit proposes to emit -----------------
# unit      copy-from                                  nextTaskId   child base prefix
PLAN_ADD = [
    ("E02", R + "/E02/out/E02.handoff.json", "FIX-1", "cc036f2f8c3b"),
    ("FIX-2", R + "/FIX-2/out/FIX-2.handoff.json", "FIX-3B", "24f42fba3f71"),
    ("FIX-3C", R + "/FIX-3C/FIX-3C.handoff.json", "FIX-4A", "74b54eb17f51"),
    ("T09", R + "/T09/out/T09.handoff.json", "R01", "3bb21ab2e4b4"),
    ("X07", R + "/X07/out-final/X07.handoff.json", "X08", "45d42acb70fc"),
    ("V06", R + "/V06/out-final/V06.handoff.json", "X01", "900bf8a3b10d"),
]


def add_records(recs):
    out = list(recs)
    for unit, src, nxt, prefix in PLAN_ADD:
        d = copy.deepcopy(json.load(open(src)))
        full = next(
            (
                r["rec"]["baseSha"]
                for r in recs
                if r["rec"]["taskId"] == nxt and r["rec"]["baseSha"].startswith(prefix)
            ),
            None,
        )
        assert full, "no record for %s@%s" % (nxt, prefix)
        d["nextTaskId"] = nxt
        d["nextBaseSha"] = full
        out.append({"unit": unit, "gen": "out-chain", "file": "%s/%s/out-chain/%s.handoff.json" % (R, unit, unit), "rec": d})
    return out


if __name__ == "__main__":
    for label, units_sel, add in (
        ("BEFORE  (scanner as it stands)", lambda d: [x for x in d if isunit(x, True)], False),
        ("AFTER1  (unit regex fixed only)", lambda d: [x for x in d if isunit(x, False)], False),
        ("AFTER2  (regex fixed + 6 corrected generations)", lambda d: [x for x in d if isunit(x, False)], True),
    ):
        recs = load(units_sel(dirs))
        if add:
            recs = add_records(recs)
        canon, bykey, bad, orph = analyze(recs)
        print("\n%s\n  records=%d canonical=%d offenders=%d orphans=%d" % (label, len(recs), len(canon), len(bad), len(orph)))
        for b in bad:
            print("   OFFENDER", b)
        for o in orph:
            print("   ORPHAN  ", o)

    # X08 detail, the one case whose orphan status changed between the two regexes
    for old in (True, False):
        recs = load([d for d in dirs if isunit(d, old)])
        canon, bykey, bad, orph = analyze(recs)
        c = canon.get("X08")
        named = set()
        for r in recs:
            if canon.get(r["unit"], {}).get("file") == r["file"] and r["rec"].get("nextTaskId"):
                named.add(r["rec"]["nextTaskId"] + "@" + r["rec"]["nextBaseSha"])
        key = c["rec"]["taskId"] + "@" + c["rec"]["baseSha"]
        print(
            "\nX08 with old regex=%s: canonical gen=%s key=%s named=%s" % (old, c["gen"], key[:24], key in named)
        )
        print("   namers of X08:", [
            "%s/%s->%s" % (r["unit"], r["gen"], r["rec"]["nextBaseSha"][:12])
            for r in recs
            if r["rec"].get("nextTaskId") == "X08"
        ])
