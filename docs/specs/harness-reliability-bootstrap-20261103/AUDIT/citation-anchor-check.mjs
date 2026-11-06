#!/usr/bin/env node
/**
 * Content-anchored citation check for runbook prose.
 *
 *     node AUDIT/citation-anchor-check.mjs <git-ref> <file.md> [band] [--json]
 *
 * WHY THIS EXISTS, and why the audit that already existed did not.
 * `ROLLOUT.md` #592 was reported clean by a filename-based audit ("44 citations, 0 missing, 0 out of
 * range"), and #601 then shifted ~50 lines of `resilienceConfig.ts` underneath it. Every citation
 * stayed in range. Most were pointing at the wrong code. A range check cannot see that class of
 * defect at all: it asks "does this file have that many lines", not "does the cited line say what
 * the row claims it says". #607's own body put it best: **an in-range citation is not a correct
 * citation.** This tool answers the second question.
 *
 * HOW: for each citation, take the nearest code-shaped token in the prose BEFORE it (the anchor --
 * usually the environment variable, function, field or class the row is about) and test whether that
 * anchor occurs at, or within `band` lines of, the cited line.
 *
 * WHAT IT CANNOT DO -- read this before believing a number:
 *   - NO_ANCHOR is NOT a pass. When no identifier precedes a citation (prose like `10 m / 2 m`,
 *     "`auto`", a bare "floors at 1") the tool has nothing to compare and reports the citation as
 *     unjudged. A document can hold a large NO_ANCHOR population while still being wrong. Those rows
 *     need a human, or an edit that names the symbol the cited line contains.
 *   - ANCHOR_MISSING is a CANDIDATE, not a verdict. Four real ways it fires without the document
 *     being wrong, all observed while building this: an env var cited at its *field* line
 *     (`PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE` vs `modelFallbackInteractive: false`); a default
 *     cited at a constant whose name differs from the prose (`5000` vs `MAX_LAST`); a cited line
 *     that *calls* the function owning the behaviour; a comment line above the code. Each was
 *     resolved by making the prose name the symbol on the cited line, which is a documentation
 *     improvement rather than a suppression. There is deliberately no allowlist.
 *   - File binding follows Markdown structure: an explicit path is remembered PER TABLE COLUMN, so a
 *     row's bare `:146` inherits the file that column was about. A global "last file seen anywhere"
 *     carry silently mis-attributes citations to a file mentioned later in the same row.
 *   - `false`/`true`/`null`/`undefined` are not anchors. They appear on nearly every line, so
 *     accepting them manufactures confidence: an earlier version of this script "found" 7 anchors
 *     that way, all of them fake.
 *
 * Exit status: 1 if any citation is ANCHOR_MISSING or OUT_OF_RANGE. NO_ANCHOR does not fail the run
 * and must never be reported as a pass -- the summary line prints it separately for that reason.
 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const pos = argv.filter((a) => !a.startsWith("--"));
const REF = pos[0];
// The band is a positional number, so it must be removed from the file list rather than merely
// detected in it -- `check.mjs <ref> <file> 4` otherwise tries to read a document named "4".
const bandArg = pos.slice(1).find((a) => /^\d+$/.test(a));
const FILES = pos.slice(1).filter((a) => a !== bandArg);
const BAND = Number(bandArg ?? 4) || 4;
if (!REF || FILES.length === 0) {
  console.error("usage: citation-anchor-check.mjs <git-ref> <file.md> [band] [--json]");
  process.exit(2);
}
const git = (args, opt = {}) =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 1 << 28, ...opt });

try {
  git(["cat-file", "-e", `${REF}^{commit}`]);
} catch {
  console.error(`not a commit: ${REF}`);
  process.exit(2);
}

const STOP = new Set(["false", "true", "null", "undefined", "const", "let", "return", "string", "number", "boolean", "void", "type", "interface", "import", "export", "this", "new", "case", "default"]);
// An anchor must LOOK like a declared symbol: an ENV_NAME, a CamelCase type, or a camelCase value.
// "Any backticked word of length >= 4" was wrong in a way worth remembering: the runbook discusses
// typo VALUES (`=ture`, `=diable`) that the source itself quotes in comments, so `ture` was
// "present in the target file" and every nearby citation became a confident ANCHOR_MISSING. Same for
// ordinary prose nouns (`last`, `path`, `errors`, `reason`, `absent`). A lowercase word with no
// internal capital is prose, whatever it is quoted from.
const isIdent = (t) =>
  !STOP.has(t) &&
  (/^[A-Z][A-Z0-9_]{3,}$/.test(t) || /^[A-Z][A-Za-z0-9]{2,}$/.test(t) || /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(t));

/**
 * Tokens, in order, of two kinds: `cite` (a `` `:123` ``/`` `file.ts:123-125` `` reference) and `id`
 * (a code-shaped word). Both must be found INSIDE backticks: prose is full of `1.`, `12`, `5 s`,
 * `0`/`1` column markers and `100%`, and an unanchored numeric regex turns every one of them into a
 * phantom citation. An earlier version of this script did exactly that and reported 156 "citations"
 * in a 93-line document.
 */
function tokenize(text) {
  const toks = [];
  const span = /`([^`\n]*)`/g;
  let m;
  while ((m = span.exec(text))) {
    const inner = m[1];
    const c = inner.match(/^(?:([A-Za-z0-9_./@-]+\.(?:ts|tsx|mjs|cjs|json|md|sh))?)\s*:([0-9]+)(?:\s*-\s*([0-9]+))?$/);
    if (c && (c[1] || /[0-9]/.test(inner))) {
      toks.push({ kind: "cite", i: m.index, f: c[1] ?? null, raw: inner, a: Number(c[2]), b: Number(c[3] ?? c[2]) });
      continue;
    }
    // A span that IS a file name is a path mention, not an anchor. `taskAlignment.ts` (T07 — reached
    // from `aps/workerActivity.ts:184`) otherwise handed the tokenizer the word `taskAlignment`, which
    // does not appear at workerActivity.ts:184 (`const signals = evaluateTaskAlignment({`) -- a
    // perfectly correct citation reported as drift because the anchor was the file the author was
    // TALKING ABOUT rather than the symbol the pointer must contain.
    if (/^\.?\.?\/?(?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|mjs|cjs|json|md|sh)$/.test(inner.trim())) {
      toks.push({ kind: "path", i: m.index, t: inner.trim() });
      continue;
    }
    for (const w of inner.match(/[A-Za-z_][A-Za-z0-9_()]{2,}/g) ?? []) {
      const base = w.replace(/\($/, "");
      if (isIdent(base)) toks.push({ kind: "id", i: m.index, t: base });
    }
  }
  return toks;
}


const repoPrefix = git(["rev-parse", "--show-prefix"]).trim();

const tree = git(["ls-tree", "-r", "--name-only", REF]).split("\n").filter(Boolean);
const treeSet = new Set(tree);
const filesOf = new Map();
const resolveFile = (f, docDir) => {
  if (!f) return null;
  if (filesOf.has(f)) return filesOf.get(f);
  // The document cites files both as full paths and as bare names (`resilientStream.ts:635`), and a
  // bare name is not a path ls-tree will find. Resolve: exact -> doc-relative -> repo-prefix ->
  // unique suffix. A suffix matching several files is NOT guessed: it is reported NO_FILE, because
  // picking one would invent a citation target.
  const cands = [f];
  if (docDir) cands.push(`${docDir}/${f}`);
  cands.push(`${repoPrefix}${f}`, `docs/${f}`);
  let hit = cands.find((c) => treeSet.has(c)) ?? null;
  // Unique-suffix matching applies to PARTIAL paths too, not just bare names. With the old
  // `!f.includes("/")` guard, `aps/workerActivity.ts:184` (a partial path the runbook writes to
  // distinguish it from other files of that name) resolved to nothing and silently inherited whatever
  // file the row had mentioned last -- then got reported as drift in a file the author never named.
  if (!hit) {
    const suffix = tree.filter((p) => p === f || p.endsWith(`/${f}`));
    if (suffix.length === 1) hit = suffix[0];
  }
  filesOf.set(f, hit);
  return hit;
};
const linesCache = new Map();
const linesOf = (f) => {
  if (!linesCache.has(f)) {
    try {
      linesCache.set(f, git(["show", `${REF}:${f}`]).split("\n"));
    } catch {
      linesCache.set(f, []);
    }
  }
  return linesCache.get(f);
};

const rows = [];
for (const doc of FILES) {
  let text;
  try {
    text = git(["show", `${REF}:${doc}`]);
  } catch {
    try {
      text = git(["show", `${REF}:./${doc}`]);
    } catch {
      console.error(`cannot read ${doc} at ${REF}`);
      process.exit(2);
    }
  }
  const docDir = doc.includes("/") ? doc.slice(0, doc.lastIndexOf("/")) : "";
  const docLines = text.split("\n");
  // File binding, in the document's own convention: a table row names its file ONCE (usually in
  // the symbol column) and every later bare `:NN` on that row belongs to it; a row that names no
  // file at all continues the previous row's file. Two wrong versions of this rule were built and
  // both were caught by measurement, so they are recorded here:
  //   - "last file seen anywhere, globally" attributes a bare `:146` to a file mentioned LATER in
  //     the same row, which fabricates drift;
  //   - "same column only" loses the file for every citation in a defaults/notes column, which is
  //     where most of the drift actually lives -- it reported 34 NO_FILE and 79 drift on a document
  //     whose real defect count is single digits.
  // Rule: last explicit path BEFORE the citation on this line; else the previous table row's last
  // explicit path; carry resets on a non-table line, because a new section is a new context.
  // A bare `:NN` is bound TWO ways and the two must agree, because the document's own convention
  // ("a bare ref means whichever file this row is about") is not determinate: row 21 is about
  // resilienceConfig.ts in its `:91-93` and about resilientStream.ts in its `:678`, and row 20's
  // mention of resilientStream.ts flips any row-scoped carry for the rows after it. Binding by row
  // alone silently checked ~30 citations against the wrong file and called it a pass; binding by
  // column alone lost the file for whole columns. When they disagree the citation is reported
  // BARE_AMBIGUOUS: the reference, not the line number, is the defect, and the fix is to name the
  // file in the citation.
  let rowCarry = null;
  const colCarry = new Map();
  const cellOf = (line, i) => {
    const cells = line.split("|");
    let acc = 0;
    for (let c = 0; c < cells.length; c++) {
      acc += cells[c].length + 1;
      if (i < acc) return c;
    }
    return cells.length - 1;
  };
  docLines.forEach((line, idx) => {
    const isTable = line.trimStart().startsWith("|");
    if (!isTable) {
      rowCarry = null;
      colCarry.clear();
    }
    if (!/`[^`\n]*:?\d/.test(line)) return;
    const toks = tokenize(line);
    // One left-to-right walk: an explicit path binds the citations that FOLLOW it, and nothing
    // before it. A two-pass "any path on the row binds the row" version mis-binds a citation that
    // precedes its own file.
    let cur = rowCarry;
    const explicit = [];
    // A path named WITHOUT a line number still binds the citations that follow it -- "Its fail-closed
    // deny rules live in `src/plannerWorker/contract.ts` (...): ... (`:62-80`)" is the runbook's most
    // common shape, and ignoring the unnumbered name left `:62-80` attached to whichever file was
    // named lines earlier, then reported as drift in the wrong file.
    for (const t of toks) {
      if (t.kind !== "path") continue;
      const r = resolveFile(t.t, docDir);
      if (r) explicit.push({ i: t.i, r });
    }
    for (const t of toks) {
      if (t.kind !== "cite" || !t.f) continue;
      const r = resolveFile(t.f, docDir);
      if (r) explicit.push({ i: t.i, r });
    }
    explicit.sort((a, b) => a.i - b.i);
    const colBindAt = (t) => {
      const col = cellOf(line, t.i);
      let b = colCarry.get(col) ?? null;
      for (const e of explicit) if (e.i < t.i && cellOf(line, e.i) === col) b = e.r;
      return b;
    };
    for (const t of toks) {
      if (t.kind !== "cite") continue;
      let file = null;
      if (t.f) {
        const r = resolveFile(t.f, docDir);
        if (r) {
          file = r;
          cur = r;
          rowCarry = r;
        }
      }
      // adopt any unnumbered path named just before this citation
      for (const e of explicit) if (e.i < t.i && !t.f) cur = e.r;
      if (!file && !t.f) file = cur;
      let ambiguous = null;
      if (!file) {
        const rowBind = cur;
        const colBind = colBindAt(t);
        if (rowBind && colBind && rowBind !== colBind) ambiguous = { rowBind, colBind };
        file = rowBind ?? colBind ?? null;
      }
      if (ambiguous) {
        // Which file did the author mean? Ask the anchor, not the layout: if the nearest symbol of
        // this row appears at the cited lines in exactly ONE candidate, that is evidence. If it
        // appears in both, or neither, the tool cannot say -- a human must name the file.
        const wantSym = toks.filter((x) => x.kind === "id" && x.i < t.i && cellOf(line, x.i) === cellOf(line, t.i)).map((x) => x.t).reverse().find((c) => linesOf(ambiguous.rowBind).join("\n").includes(c) || linesOf(ambiguous.colBind).join("\n").includes(c)) ?? null;
        const hitIn = (f) => {
          const ls = linesOf(f);
          for (let n = Math.max(1, t.a - BAND); n <= Math.min(ls.length, t.b + BAND); n++) if (wantSym && ls[n - 1]?.includes(wantSym)) return n;
          return 0;
        };
        const hr = hitIn(ambiguous.rowBind);
        const hc = hitIn(ambiguous.colBind);
        const sugg = hr && !hc ? ambiguous.rowBind : hc && !hr ? ambiguous.colBind : null;
        rows.push({ doc, line: idx + 1, file, raw: t.raw, cite: `${t.a}${t.b !== t.a ? `-${t.b}` : ""}`, anchor: wantSym, found: 0, verdict: "BARE_AMBIGUOUS", at: `row=${ambiguous.rowBind} column=${ambiguous.colBind}`, target: sugg ? `anchor supports ${sugg}` : "anchor matches neither or both -- name the file by hand" });
        continue;
      }
      const lines = file ? linesOf(file) : [];
      // The anchor is the nearest preceding identifier THAT THE TARGET FILE ACTUALLY CONTAINS. "The
      // nearest identifier" alone was not enough: prose backticks (`ture`, `diable`, `--last`,
      // `path`) are code-shaped but are not symbols of the file, and each one produced a confident
      // ANCHOR_MISSING. If no preceding token is a symbol of the file, there is nothing to compare,
      // so the citation is reported NO_ANCHOR (unjudged) rather than guessed.
      // Anchors are scoped to the SAME cell as the citation. The unscoped version compared a
      // citation in a runbook table's last column against an ENV_NAME two columns earlier, and
      // reported the last column as drift -- the anchor was simply about a different file. In prose
      // a line is one cell, so this changes nothing there.
      const citeCell = cellOf(line, t.i);
      const fileText = file ? lines.join("\n") : "";
      // Adjacency, not proximity-in-the-line: the runbook writes `X` `:N`, so N must contain X.
      // Searching the whole cell let a symbol from an earlier clause anchor a later clause's pointer
      // ("`scopeGlobError` rejects ... (`:62-80`); an authorization deny wholly covering a grant ...
      // (`:137-146`)"), and the second, CORRECT citation was reported as drift because it did not
      // contain the first clause's symbol. Four backtick-spans is enough for "(`file.ts:12`", which is
      // the only thing legitimately written between a name and its pointer.
      // ANCHOR_MAX_SPANS counts BACKTICK SPANS, not characters: the runbook's own shape is
      // "`PI_INFERENCE_CIRCUIT_FAILURES` `:185`" (one span apart) and "(`file.ts:12`" leaves the
      // filename between name and pointer (two spans apart). An earlier version compared character
      // offsets here, which quietly turned the whole anchor check off -- every citation came back
      // NO_ANCHOR and the run looked clean.
      // The runbook's grammar is "`X` `:N`", so the cited line must contain X. That makes the anchor a
      // SAME-CLAUSE neighbour: a `;` or `. ` ends one claim and the next pointer belongs to the next.
      // Both earlier attempts were wrong in opposite directions and each produced a run that LOOKED
      // authoritative: matching any identifier earlier in the cell anchored a correct citation to the
      // previous clause's symbol ("`scopeGlobError` rejects ... (`:62-80`); an authorization deny
      // wholly covering a grant ... (`:137-146`)" -> the second, correct pointer flagged as drift),
      // while counting backtick spans made unbackticked prose invisible and flagged nothing at all.
      const ANCHOR_MAX_CHARS = 60;
      const preceding = toks
        .filter((x) => x.kind === "id" && x.i < t.i && cellOf(line, x.i) === citeCell && t.i - x.i <= ANCHOR_MAX_CHARS)
        .filter((x) => !/[;.](\s|$)/.test(line.slice(x.i + x.t.length + 1, t.i)))
        .map((x) => x.t);
      let want = null;
      for (const cand of preceding.reverse()) {
        if (fileText.includes(cand)) { want = cand; break; }
      }
      const at = file && t.a >= 1 && t.a <= lines.length ? lines[t.a - 1] : undefined;
      const outOfRange = file ? t.b > lines.length : false;
      let verdict;
      if (!file) verdict = "NO_FILE";
      else if (outOfRange) verdict = "OUT_OF_RANGE";
      else if (!want) verdict = "NO_ANCHOR";
      else if (at && at.includes(want)) verdict = "ANCHOR_AT";
      else {
        const lo = Math.max(1, t.a - BAND);
        const hi = Math.min(lines.length, t.b + BAND);
        let found = 0;
        for (let n = lo; n <= hi; n++) if (lines[n - 1]?.includes(want)) { found = n; break; }
        verdict = found ? "ANCHOR_NEARBY" : "ANCHOR_MISSING";
        rows.push({ doc, line: idx + 1, file, raw: t.raw, cite: `${t.a}${t.b !== t.a ? `-${t.b}` : ""}`, anchor: want, found, verdict, at: (at ?? "").trim().slice(0, 110), target: found ? (lines[found - 1] ?? "").trim().slice(0, 110) : "" });
        continue;
      }
      rows.push({ doc, line: idx + 1, file, raw: t.raw, cite: `${t.a}${t.b !== t.a ? `-${t.b}` : ""}`, anchor: want, found: 0, verdict, at: (at ?? "").trim().slice(0, 110), target: "" });
    }
    // Publish this row's explicit paths to the column carry AFTER the row is judged, so a column
    // never binds against a path that appears later in its own row.
    for (const e of explicit) colCarry.set(cellOf(line, e.i), e.r);
  });
}



// --resolve <path>: print how a written path binds. Added because a citation written
// `aps/workerActivity.ts:184` came back bound to src/workers/PiWorkerExecutor.ts, and guessing why a
// resolver missed is not debugging.
if (process.argv.includes("--resolve")) {
  for (const arg of process.argv.slice(process.argv.indexOf("--resolve") + 1)) {
    console.log(`${arg}  ->  ${resolveFile(arg, "") ?? "NULL"}  (direct=${treeHas(arg)})`);
  }
  process.exit(0);
}

const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
const bad = rows.filter((r) => ["ANCHOR_MISSING", "OUT_OF_RANGE", "NO_FILE", "BARE_AMBIGUOUS"].includes(r.verdict));
if (json) console.log(JSON.stringify({ ref: REF, band: BAND, citations: rows.length, tally, bad, rows }, null, 2));
else {
  console.log(`ref=${REF} band=${BAND} citations=${rows.length}`);
  for (const k of ["ANCHOR_AT", "ANCHOR_NEARBY", "ANCHOR_MISSING", "BARE_AMBIGUOUS", "NO_FILE", "OUT_OF_RANGE", "NO_ANCHOR"]) {
    console.log(`  ${k.padEnd(15)}${tally[k] ?? 0}`);
  }
  console.log("  --- problems ---");
  for (const r of bad) {
    console.log(`  ${r.verdict}  ${r.doc.split("/").pop()}:${r.line}  ${r.file ?? "?"}:${r.cite}  want=${r.anchor ?? "-"} found=${r.found || "-"}`);
    if (r.at) console.log(`      cited  ${r.at}`);
    if (r.target) console.log(`      found  ${r.target}`);
  }
  console.log(`RESULT drift=${bad.length}`);
  if ((tally.NO_ANCHOR ?? 0) > 0) {
    console.log(`NOTE ${tally.NO_ANCHOR} citation(s) were NOT judged: no identifier near the citation to compare against.`);
    console.log(`     Those are neither pass nor fail. Do not report this run as "citations verified".`);
  }
}
process.exit(bad.length > 0 ? 1 : 0);
