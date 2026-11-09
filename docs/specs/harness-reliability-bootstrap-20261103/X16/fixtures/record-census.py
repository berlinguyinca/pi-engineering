#!/usr/bin/env python3
"""Which tracked records does each version of AUDIT/integrity-scan.mjs open?

Re-runnable: python3 docs/specs/harness-reliability-bootstrap-20261103/X16/fixtures/record-census.py
It reproduces the two selection rules from the scanners themselves (the X15 rule is generations only;
the X16 rule adds tracked records elsewhere, chosen by name or by schema shape) and prints the census
per location, so the records=119 -> records=228 change is arithmetic on git's file list, not prose.
"""
import json, os, subprocess, sys

SPEC = "docs/specs/harness-reliability-bootstrap-20261103"
RANK = {"out-erratum": 6, "out-chain": 5, "out-final": 4, "out-corrected": 3, "out": 1}
NON_UNIT = {"AUDIT", "examples", "manifests", "templates"}
NEG = ("negctl", "noparent", "tampered")


def rank(g):
    if g in RANK:
        return RANK[g]
    if any(n in g for n in NEG):
        return 0.5
    return 2 if g.startswith("out") else -1


def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout.split()


required = json.load(open(f"{SPEC}/templates/handoff.schema.json"))["required"]
tracked = git("ls-files", SPEC)
jsons = [f for f in tracked if f.endswith(".json")]

# units, as the scanners compute them: any directory under SPEC holding a generation directory that
# holds a .json. Generation = out*-named subdirectory with at least one .json.
units = []
for d in sorted(os.listdir(SPEC)):
    p = os.path.join(SPEC, d)
    if not os.path.isdir(p) or d in NON_UNIT:
        continue
    if any(
        os.path.isdir(os.path.join(p, g))
        and rank(g) >= 0
        and any(n.endswith(".json") for n in os.listdir(os.path.join(p, g)))
        for g in os.listdir(p)
    ):
        units.append(d)


def gens(u):
    p = os.path.join(SPEC, u)
    return [
        g
        for g in os.listdir(p)
        if os.path.isdir(os.path.join(p, g)) and rank(g) >= 0 and any(n.endswith(".json") for n in os.listdir(os.path.join(p, g)))
    ]


gen_files = {f"{SPEC}/{u}/{g}/{n}" for u in units for g in gens(u) for n in os.listdir(os.path.join(SPEC, u, g)) if n.endswith(".json")}
unit_dir = [f for f in jsons if len(f.split("/")) == len(SPEC.split("/")) + 2 and f.split("/")[3] in units and f not in gen_files]


def shaped(f):
    try:
        d = json.load(open(f))
    except Exception:
        return False
    return isinstance(d, dict) and all(k in d for k in required)


named = lambda f: "handoff" in os.path.basename(f) and f.endswith(".json")  # noqa: E731

elsewhere = [
    f
    for f in jsons
    if f not in gen_files
    and f not in unit_dir
    and f.split("/")[3] not in NON_UNIT
    and (named(f) or shaped(f))
]
x16_reads = gen_files | set(unit_dir) | set(elsewhere)

print(f"tracked files under {SPEC}: {len(tracked)}   of them .json: {len(jsons)}")
print(f"unit directories (structural rule, both scanners): {len(units)}")
print(f"  read by the scan as merged at 46a7109b (generation directories only): {len(gen_files)}")
print(f"  additionally read by the X16 scan:                                  {len(x16_reads) - len(gen_files)}")
print(f"    records sitting directly in a unit directory: {len(unit_dir)}")
for f in unit_dir:
    print(f"      {f}")
print(f"    record-shaped files elsewhere (fixtures/, nested dirs): {len(elsewhere)}")
for f in elsewhere:
    kind = "payload fixture (no handoffHash)" if not shaped(f) else ("control" if "tampered" in f or "negctl" in f or "noparent" in f else "record copy")
    print(f"      {f}  [{kind}]")
print(f"total records read: X15 scan {len(gen_files)}, X16 scan {len(x16_reads)}")
print("of the unit-directory records, these are the ones X15's chain generations copy (so the scan")
print("printed links for them while never opening them):")
for f in unit_dir:
    if os.path.exists(os.path.join(SPEC, f.split("/")[3], "out-chain")) and f.split("/")[3] in ("T09", "FIX-3C"):
        print(f"      {f}")
