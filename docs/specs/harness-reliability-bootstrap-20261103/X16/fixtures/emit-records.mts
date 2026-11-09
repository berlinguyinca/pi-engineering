// Emit X16's handoff record and the X15/out-chain generation that names it.
//
//   npx tsx docs/specs/harness-reliability-bootstrap-20261103/X16/fixtures/emit-records.mts \
//     <baseSha> <resultSha> <x15-outchain-hash> <approvedAt>
//
// baseSha   = the commit that carries the scanner change (X16's task commit)
// resultSha = the commit that carries the logs and scripts proving it (X16's evidence commit)
//
// Hashing is the trail's own canonicalHash (src/bootstrap/resultGate.ts:36), which sorts every key and
// drops handoffHash, so a record's hash is a function of the bytes below it and nothing else. The X15
// copy changes nextTaskId/nextBaseSha, adds two evidence references and one note paragraph -- every
// other byte is X15/out/X15.handoff.json's, which is what makes it a generation of X15 rather than a
// new unit.
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalHash } from "../../../../../src/bootstrap/resultGate.ts";

const R = "docs/specs/harness-reliability-bootstrap-20261103";
const [baseSha, resultSha, approvedAt] = process.argv.slice(2);
const write = (path: string, record: Record<string, unknown>) => {
  const full = { ...record };
  delete full.handoffHash;
  full.handoffHash = canonicalHash(full);
  writeFileSync(path, JSON.stringify(full, null, 2) + "\n");
  console.log(`${path}  ${full.handoffHash}`);
  return full;
};

// 1. X15's chain generation: the terminal record, plus the pointer this unit's existence creates.
const x15 = JSON.parse(readFileSync(`${R}/X15/out/X15.handoff.json`, "utf8"));
const x15Chain: Record<string, unknown> = {
  ...x15,
  nextTaskId: "X16",
  nextBaseSha: baseSha,
  evidence: [
    ...x15.evidence,
    `${R}/X16/logs/01-old-scan-on-the-new-tree.txt`,
    `${R}/X16/logs/03-controls.txt`,
  ],
  operatorApproval: {
    ...x15.operatorApproval,
    notes:
      x15.operatorApproval.notes +
      `\n\nX16: X15 was emitted terminal (nextTaskId null) and the trail continued past it, so the` +
      ` record that names X15's child had to be a new generation of X15. This one names X16 at ${baseSha},` +
      ` the commit whose scanner reads the records X15's own generations copy -- X15/out printed links for` +
      ` T09/out-chain and FIX-3C/out-chain while never opening the records they copy (X16/logs/01, and C1` +
      ` of X16/logs/03, where flipping status in T09/T09.handoff.json leaves X15's scan printing RESULT ok` +
      ` with exit 0). Only nextTaskId, nextBaseSha, two evidence references and this paragraph differ from` +
      ` X15/out/X15.handoff.json; the corrected values X15 wrote for its own pointers stay byte-identical.`,
  },
};
write(`${R}/X15/out-chain/X15.handoff.json`, x15Chain);

// 2. X16's record. Same shape as every other record in the trail: templates/handoff.schema.json, 15
//    properties, additionalProperties false.
const scan = `${R}/AUDIT/integrity-scan.mjs`;
const L = (n: string) => `${R}/X16/logs/${n}`;
const x16: Record<string, unknown> = {
  specVersion: "1.2.0",
  taskId: "X16",
  status: "PASS",
  repo: "berlinguyinca/pi-engineering",
  baseSha,
  resultSha,
  // Carried forward, not earned: X16 has no TaskManifest of its own (it is post-merge follow-up in X15's
  // scope), and neither do X14's or X15's records -- grepping the repository for X15's value
  // (9766e2fb...) finds it only inside X15's own records, so no stored object reproduces it. The scan
  // checks the field's presence and the record hash, never the authority, so it says nothing either way.
  // Making this field point at a stored, re-hashable object is part of what X16/logs/06 hands to X17.
  taskAuthorityHash: JSON.parse(readFileSync(`${R}/X15/out/X15.handoff.json`, "utf8")).taskAuthorityHash,
  changedFiles: [`${R}/AUDIT/integrity-scan.mjs`, `${R}/AUDIT/chain-declaration.json`],
  commands: [
    {
      command: `git show 46a7109b:${scan} > /tmp/x16-old-scanner.mts && npx tsx /tmp/x16-old-scanner.mts   # the scan as merged, over ${baseSha}`,
      exitCode: 0,
      outputArtifact: L("01-old-scan-on-the-new-tree.txt"),
    },
    {
      command: `npx tsx ${scan}   # at ${baseSha}, before this unit's records`,
      exitCode: 0,
      outputArtifact: L("02-scan-after-x16.txt"),
    },
    {
      command: `bash ${R}/X16/fixtures/x16-controls.sh   # C1-C9: tamper, fabricated control, declaration, checkout and cwd cases`,
      exitCode: 0,
      outputArtifact: L("03-controls.txt"),
    },
    {
      command: `npx tsx ${scan} && npx tsx ${R}/AUDIT/lineage-scan.mjs && npx tsx ${R}/AUDIT/record-reproducibility.mjs && npm run lint && npm run typecheck:core && npm run test:unit   # at ${baseSha}`,
      exitCode: 0,
      outputArtifact: L("05-gates-at-task-commit.txt"),
    },
  ],
  evidence: [
    scan,
    `${R}/AUDIT/chain-declaration.json`,
    L("01-old-scan-on-the-new-tree.txt"),
    L("02-scan-after-x16.txt"),
    L("03-controls.txt"),
    L("04-declaration-truth-table.txt"),
    L("05-gates-at-task-commit.txt"),
    `${R}/X16/fixtures/x16-controls.sh`,
    `${R}/X16/fixtures/rehash.mts`,
    `${R}/X16/fixtures/record-census.py`,
    `${R}/X16/fixtures/emit-records.mts`,
    `${R}/X15/out-chain/X15.handoff.json`,
  ],
  nextTaskId: null,
  nextBaseSha: null,
  blockedReasons: [],
  operatorApproval: {
    required: true,
    approved: true,
    approvedBy:
      "operator (blanket instruction 2026-11-04: continue automatically; no per-task review) -- the operator" +
      " asked for the missing links to be fixed and the things that need closing to be closed",
    approvedAt,
    notes:
      `The scan at 46a7109b built its record list from unit directories x generation directories and opened` +
      ` nothing else: 119 of the 228 tracked records. Flipping status to FAIL in T09/T09.handoff.json -- a` +
      ` tracked record, one whose correction X15's own PR body announces -- left it printing RESULT ok with` +
      ` exit 0 (C1 of X16/logs/03). It accepted a fabricated negative-control record as a canonical child` +
      ` (C2, the probe from review-650 finding P5); it printed canonical records no parent names as a count` +
      ` it then ignored, which is why #650 could merge with four broken links and seven unnamed records; and` +
      ` the 66 payload fixtures under */fixtures/ were invisible to it.\n\nThis unit: every tracked record is` +
      ` read and counted where it lives (in generations=119, in unit directories=41, elsewhere=68); an` +
      ` unnamed canonical record is an ORPHAN-OFFENCE unless AUDIT/chain-declaration.json says why, and a` +
      ` declaration that stops applying is a STALE-DECLARATION, so B00's chain-head exception and the tampered` +
      ` control's hash waiver have to keep earning their place; named controls can no longer satisfy a forward` +
      ` link; and each payload fixture must equal another record of its own unit apart from handoffHash. No` +
      ` runtime code and no test changed -- test:unit is 6784 tests, 6779 pass, 0 fail, 5 skipped, the same` +
      ` as at X15's commit (X16/logs/05).\n\nTwo limits this unit does not remove. RESULT ok still does not` +
      ` certify that the trail is one connected walk; the chain walk plus the declared exceptions do, and the` +
      ` comment above the exit status says so; taskAuthorityHash is carried from X15 and reproduces from` +
      ` nothing stored in the repo; and nothing runs these scans on push: this repo has no` +
      ` .github/workflows since 85b1b064 removed them, so the claim in #650's body and #650's review that CI` +
      ` runs AUDIT/integrity-scan.mjs is false, and ` +
      `main can drift into an offending state with nothing noticing. That is recorded as X17's first task.`,
  },
};
write(`${R}/X16/out/X16.handoff.json`, x16);
