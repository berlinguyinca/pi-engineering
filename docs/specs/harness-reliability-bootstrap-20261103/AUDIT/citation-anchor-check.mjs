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
 * HOW an anchor is chosen -- every clause here is the residue of a false failure seen in practice:
 *   - It must be a NAME IN BACKTICKS of SYMBOL SHAPE (CONSTANT_NAME, CamelCase, camelCase), within 60
 *     characters of the pointer, in the SAME TABLE COLUMN and the SAME CLAUSE (no `. ` or `;` between).
 *     Prose outside backticks is never an anchor: `executor.ts:547-554 (bounded, non-blocking)` read
 *     "bounded" as its anchor and reported a correct citation as drift.
 *   - NEAREST ONLY, with no fallback. "Walk backward until some token occurs in the target file" was
 *     the single biggest false-failure source: `JSON` answered for a pointer that named `fnv1a64`, and
 *     `WAIT_STATUSES` (already the anchor of the citation before it) answered for `signals.ts:728`.
 *     A name an earlier citation on the line already used is not available again.
 *   - A parenthetical AFTER the pointer naming a symbol wins over anything before it, because that is
 *     how a row says "line N is where `foo` lives". A parenthetical that is itself a file citation
 *     (`retryPolicy.ts:100`) names a file, not a symbol, and is not used.
 *   - VALUE-SHAPED names are never judged: snake_case keys (`tool_loop_limit`, `loop_candidate`),
 *     string literals and patterns (`evidence: scope gate:`, `superseded/*`), paths
 *     (`~/.local/state/pi-engineering`), flags (`--export <path>`) and digit-bearing names (`fnv1a64`).
 *     A row cites the code that HANDLES such a value -- the append call for an event name, the option
 *     parser for a flag, the resolver for a state root -- and the value's own text is not on that line.
 *     Judged by containment, four already-verified-correct citations came back ANCHOR_MISSING
 *     (ROLLOUT.md:29/78/80 and the event-key rows of ERROR_SOURCES.md), which costs more trust than the
 *     missed finding earns. Such a name CLOSEST to the pointer silences the judgement for that citation
 *     and is reported in the row's `hint` field (--json), so a human still sees what was named.
 *
 * FILE BINDING follows Markdown structure: an explicit path is remembered PER TABLE COLUMN, so a row's
 * bare `:146` inherits the file that column was about; in prose the path carries to the end of the
 * PARAGRAPH (a citation wrapped across lines inherited nothing and was reported NO_FILE -- the
 * sentence was correct). A bare pointer whose column-bound file and row-bound file disagree is
 * BARE_AMBIGUOUS and FAILS rather than being guessed: `taskAlignment.ts:137-146` sits in the column
 * about `workerActivity.ts`, and the row's `:130` belongs to `workerActivity.ts:130-132`, so either
 * binding produces a confident wrong answer. The fix is to name the file, not to teach the tool to guess.
 *
 * WHAT IT CANNOT DO -- read this before believing a number:
 *   - NO_ANCHOR is NOT a pass. When no symbol-shaped name sits adjacent to a citation (prose like
 *     `10 m / 2 m`, "`auto`", a bare "floors at 1", or any value-shaped row) the tool has nothing to
 *     compare and reports the citation as unjudged. A document can hold a large NO_ANCHOR population
 *     while still being wrong. Those rows need a human, or an edit that names the symbol the cited line
 *     contains. Measured on this repo's docs/specs: about 140 citations are judged and ~400 are not.
 *   - ANCHOR_MISSING is a CANDIDATE, not a verdict. Four real ways it fires without the document
 *     being wrong, all observed while building this: an env var cited at its *field* line
 *     (`PI_INFERENCE_MODEL_FALLBACK_INTERACTIVE` vs `modelFallbackInteractive: false`); a default
 *     cited at a constant whose name differs from the prose (`5000` vs `MAX_LAST`); a cited line
 *     that *calls* the function owning the behaviour; a comment line above the code. Each was
 *     resolved by making the prose name the symbol on the cited line, which is a documentation
 *     improvement rather than a suppression. There is deliberately no allowlist.
 *   - OUT_OF_RANGE is caught; a wrong-but-in-range line inside a value-shaped row is NOT (see above).
 *   - `false`/`true`/`null`/`undefined` are not anchors. They appear on nearly every line, so
 *     accepting them manufactures confidence: an earlier version of this script "found" 7 anchors
 *     that way, all of them fake.
 *
 * Exit status: 1 if any citation is ANCHOR_MISSING or OUT_OF_RANGE. NO_ANCHOR does not fail the run
 * and must never be reported as a pass -- the summary line prints it separately for that reason.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const pos = argv.filter((a) => !a.startsWith("--"));
const REF = pos[0];
// The band is a positional number, so it must be removed from the file list rather than merely
// detected in it -- `check.mjs <ref> <file> 4` otherwise tries to read a document named "4".
const bandArg = pos.slice(1).find((a) => /^\d+$/.test(a));
const FILES_RAW = pos.slice(1).filter((a) => a !== bandArg);
const BAND = Number(bandArg ?? 4) || 4;
// --code-at <ref>: read SOURCE files at <ref> while documents are read as written. A record declares
// `Base commit: <sha>` for the tree it describes, but the record itself was committed later, so no
// single ref contains both. This is what makes the claim behind a --baseline entry testable: run the
// check with --code-at <declared base> and require drift=0. Without it, exemption-by-base is a claim a
// human asserted and nothing could re-check.
//
// --baseline <file>: documents whose citations are POINT-IN-TIME records (mission handoffs, worker
// reports, patch specs). Their line numbers describe the tree the task ran against; rewriting them to
// today's lines would make the record claim it observed numbers it never observed, so their failures
// are declared and excluded from the exit status -- listed, counted, reasoned, never silently zero.
const baselineIdx = argv.indexOf("--baseline");
const baselineFile = baselineIdx >= 0 ? argv[baselineIdx + 1] : null;
if (baselineIdx >= 0 && !baselineFile) {
  console.error("--baseline needs a file: one doc path per line, optional '| reason'");
  process.exit(2);
}
if (!REF || FILES_RAW.length === 0) {
  console.error(
    "usage: citation-anchor-check.mjs <git-ref> <file.md|dir> [band] [--json] [--baseline <file>] [--code-at <ref>]",
  );
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
// ANCHOR-ELIGIBLE SHAPES: the names a programming language uses for entities -- CONSTANT_NAMES,
// CamelCase, camelCase. Deliberately EXCLUDED, and each exclusion is evidence-backed:
//   snake_case keys (`tool_loop_limit`, `loop_candidate`, `blocked_reason`), string literals and
//   patterns (`evidence: scope gate:`, `superseded/*`), paths (`~/.local/state/pi-engineering`), flags
//   (`--export <path>`) and digit-bearing names (`fnv1a64`) are VALUES or KEYS. Documents cite the code
//   that HANDLES such a value -- the append call for an event name, the option parser for a flag, the
//   resolver for a state root -- and the value's own text is not on that line. Judged by containment,
//   four already-verified-correct citations came back ANCHOR_MISSING (ROLLOUT.md:29/78/80,
//   ERROR_SOURCES.md:26-27), which is a false failure that costs more trust than the missed finding
//   earns. They are reported as hints under NO_ANCHOR instead: unjudged, visible, for a human.
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
    // Each identifier carries its OWN offset inside the span. Giving every word of a multi-word span
    // the span's opening index made `JSON.stringify`'s two words tie for "nearest", so the further one
    // could win and a citation was judged against the wrong symbol.
    // A span that is code but not a bare identifier -- `evidence: scope gate:`, `--export <path>`,
    // `~/.local/state/pi-engineering`, `superseded/*`. Kept ONLY as a hint: it tells a human what the
    // author named when no symbol-shape anchor exists. It is never judged, because such spans are values
    // and keys (see isIdent). Without them the citation reads as if the document named nothing at all.
    const lit = inner.trim();
    // A span is a VALUE-shaped hint when it has code punctuation (`evidence: scope gate:`,
    // `--export <path>`, `~/.local/state/pi-engineering`, `JSON.stringify`) or is a name the anchor
    // rules deliberately reject (`fnv1a64`). A bare prose word in backticks is neither, and must not be
    // able to silence a judgement.
    if (lit.length >= 3 && (/[^A-Za-z0-9_.]/.test(lit) || !isIdent(lit))) toks.push({ kind: "hint", i: m.index, t: lit });
    for (const wm of inner.matchAll(/[A-Za-z_][A-Za-z0-9_()]{2,}/g)) {
      const base = wm[0].replace(/\($/, "");
      if (isIdent(base)) toks.push({ kind: "id", i: m.index + 1 + wm.index, t: base });
    }
  }
  return toks;
}


const repoPrefix = git(["rev-parse", "--show-prefix"]).trim();

const tree = git(["ls-tree", "-r", "--name-only", REF]).split("\n").filter(Boolean);
const treeSet = new Set(tree);

// The reference the CODE is read at. Defaults to the document reference, and differs when checking a
// point-in-time RECORD: a work order declares `Base commit: <sha>` for the tree it describes, but the
// file itself was committed later, so there is no single ref at which both the record and the code it
// describes exist. `--code-at <sha>` says "read these documents as written, against that tree" -- which
// is the only way to test the claim that makes a record exempt (its pointers were right AT ITS BASE).
const codeAtIdx = argv.indexOf("--code-at");
if (codeAtIdx >= 0 && !argv[codeAtIdx + 1]) {
  console.error("--code-at needs a git ref, e.g. --code-at 5efe62fe");
  process.exit(2);
}
const codeRef = (codeAtIdx >= 0 ? argv[codeAtIdx + 1] : null) ?? process.env.PI_CITATION_CODE_AT ?? REF;
const treeCode = git(["ls-tree", "-r", "--name-only", codeRef]).split("\n").filter(Boolean);
const treeCodeSet = new Set(treeCode);
const treeCodeHas = (f) => treeCodeSet.has(f) || treeCodeSet.has(`${repoPrefix}${f}`);

// A directory argument used to match nothing, and the run then printed `RESULT drift=0` over 195
// markdown files while judging ZERO citations -- a green result from an empty sweep, which is the most
// dangerous output a gate can produce. Directories now expand, and a sweep that judges nothing fails.
const expandDocs = (arg) => {
  const a = arg.replace(/\/+$/, "");
  if (treeSet.has(a)) return a.endsWith(".md") ? [a] : [];
  // An explicitly named document that is absent at REF is kept, so the per-document read reports the
  // real reason ("exists on disk, but not in HEAD") instead of the whole sweep dying with "no markdown
  // documents matched" -- which is what blocked checking records against their own base commit.
  if (a.endsWith(".md")) return [a];
  return tree.filter((p) => p.startsWith(`${a}/`) && p.endsWith(".md"));
};
const FILES = [...new Set(FILES_RAW.flatMap(expandDocs))].sort();
if (FILES.length === 0) {
  console.error(`no markdown documents matched: ${FILES_RAW.join(", ")} (at ${REF})`);
  process.exit(2);
}

const baseline = new Map();
if (baselineFile) {
  for (const raw of readFileSync(baselineFile, "utf8").split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const [doc, reason] = l.split("|").map((s) => s.trim());
    baseline.set(doc.replace(/^HEAD:/, ""), reason || "point-in-time record");
  }
}
// Which directories a document itself talks about, used ONLY to disambiguate a bare basename
// (`executor.ts` -> 2 files, `review.ts` -> 4, `types.ts` -> 15). This is what a human reader does with
// the surrounding text; a path the author actually wrote always wins, and a basename the document gives
// no hint about stays NO_FILE rather than being guessed.
const prefixesOf = (text) => {
  const s = new Set();
  for (const m of text.matchAll(/(?:^|[\s(`[=])((?:src|test|docs|scripts)\/[\w.@-]+(?:\/[\w.@-]+)*)\//g)) s.add(m[1] + "/");
  return [...s];
};
const filesOf = new Map();
let docContextBindings = 0;
const resolveFile = (f, docDir, prefixes = []) => {
  if (!f) return null;
  if (filesOf.has(f)) return filesOf.get(f);
  // The document cites files both as full paths and as bare names (`resilientStream.ts:635`), and a
  // bare name is not a path ls-tree will find. Resolve: exact -> doc-relative -> repo-prefix ->
  // unique suffix. A suffix matching several files is NOT guessed: it is reported NO_FILE, because
  // picking one would invent a citation target.
  const cands = [f];
  if (docDir) cands.push(`${docDir}/${f}`);
  cands.push(`${repoPrefix}${f}`, `docs/${f}`);
  let hit = cands.find((c) => treeCodeSet.has(c) || treeSet.has(c)) ?? null;
  // Unique-suffix matching applies to PARTIAL paths too, not just bare names. With the old
  // `!f.includes("/")` guard, `aps/workerActivity.ts:184` (a partial path the runbook writes to
  // distinguish it from other files of that name) resolved to nothing and silently inherited whatever
  // file the row had mentioned last -- then got reported as drift in a file the author never named.
  if (!hit) {
    let suffix = treeCode.filter((p) => p === f || p.endsWith(`/${f}`));
    if (suffix.length === 0) suffix = tree.filter((p) => p === f || p.endsWith(`/${f}`));
    if (suffix.length === 1) hit = suffix[0];
    else if (suffix.length > 1 && prefixes.length) {
      const narrowed = suffix.filter((p) => prefixes.some((pre) => p.startsWith(pre)));
      if (narrowed.length === 1) {
        hit = narrowed[0];
        docContextBindings++;
      }
    }
  }
  filesOf.set(f, hit);
  return hit;
};
const linesCache = new Map();
const linesOf = (f) => {
  if (!linesCache.has(f)) {
    try {
      linesCache.set(f, git(["show", `${codeRef}:${f}`]).split("\n"));
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
  const docPrefixes = prefixesOf(text);
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
  // Prose wraps. `:176` shadows. / (applied `:88`) / (applied `:104`) all continue the file named on a
  // PRECEDING line of the same paragraph, and carry was per-line, so every wrapped pointer came back
  // NO_FILE. Tables reset at the line; paragraphs carry until a blank line ends the paragraph.
  let paraCarry = null;
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
      if (!line.trim()) paraCarry = null;
    }
    if (!/`[^`\n]*:?\d/.test(line)) return;
    const toks = tokenize(line);
    // One left-to-right walk: an explicit path binds the citations that FOLLOW it, and nothing
    // before it. A two-pass "any path on the row binds the row" version mis-binds a citation that
    // precedes its own file.
    let cur = isTable ? rowCarry : paraCarry ?? rowCarry;
    // An identifier used as one citation's anchor (or named in its parenthetical) is not available to
    // anchor a later citation on the same line. `signals.ts:81` (`WAIT_STATUSES`) and `:728`: taking
    // WAIT_STATUSES as :728's anchor reported a correct pointer at signals.ts:728
    // (`export function decideGatewayRetry(`) as drift. With nothing left, that citation is NO_ANCHOR.
    const claimed = new Set();
    const explicit = [];
    // A path named WITHOUT a line number still binds the citations that follow it -- "Its fail-closed
    // deny rules live in `src/plannerWorker/contract.ts` (...): ... (`:62-80`)" is the runbook's most
    // common shape, and ignoring the unnumbered name left `:62-80` attached to whichever file was
    // named lines earlier, then reported as drift in the wrong file.
    for (const t of toks) {
      if (t.kind !== "path") continue;
      const r = resolveFile(t.t, docDir, docPrefixes);
      if (r) explicit.push({ i: t.i, r });
    }
    for (const t of toks) {
      if (t.kind !== "cite" || !t.f) continue;
      const r = resolveFile(t.f, docDir, docPrefixes);
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
        const r = resolveFile(t.f, docDir, docPrefixes);
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
      // The anchor must be code the document actually wrote, in backticks, in the SAME CELL (a table's
      // last column must not be judged against an ENV_NAME two columns earlier -- that reported correct
      // columns as drift; in prose a line is one cell) and adjacent to the pointer. Unanchored numeric
      // matching turns prose `1.`, `12`, `5 s`, `100%` into phantom citations; an earlier version of this
      // script did that and reported 156 "citations" on a document with none.
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
      // The anchor is the SINGLE nearest code token in the same clause -- no fallback to anything
      // further back. "Walk backward until some token happens to occur in the target file" was the
      // largest source of confident FALSE failures in this tool: whatever far word existed in the file
      // answered for a pointer its nearest neighbour described (`JSON` answering for `fnv1a64`;
      // `blocked_reason` answering for the literal `evidence: scope gate:` the row actually cites), so
      // every widening of accepted anchor shapes traded one set of false failures for another. When the
      // nearest token is not in the file the citation is NO_ANCHOR -- unjudged -- which is the honest
      // verdict: the prose did not name what the cited line contains.
      const before = toks.filter((x) => x.i < t.i && cellOf(line, x.i) === citeCell && t.i - x.i <= ANCHOR_MAX_CHARS);
      const inClause = (x) => !/[;.](\s|$)/.test(line.slice(x.i + x.t.length + 1, t.i));
      const last = (a) => (a.length ? a[a.length - 1] : null);
      const anchorTok = last(before.filter((x) => x.kind === "id" && inClause(x)));
      const hintTok = last(before.filter((x) => (x.kind === "id" || x.kind === "hint") && inClause(x)));
      // A value named CLOSER to the pointer than any symbol silences the judgement: the row is about
      // that value, and a symbol a clause further back does not describe it. Without this veto,
      // "`fnv1a64` (exported from `src/aps/fingerprint.ts:158`)", where 158 IS
      // `export function fnv1a64(...)", read as drift against `JSON.stringify` three words earlier.
      const veto = !!hintTok && (!anchorTok || hintTok.i > anchorTok.i);
      const nearest = veto ? null : anchorTok?.t ?? null;
      // What the author named nearest, whatever its shape -- reported with NO_ANCHOR so a human sees
      // "the row cites the flag `--export <path>` here" rather than "nothing named".
      const nearestHint = hintTok?.t ?? null;
      let want = null;
      // The documents have TWO grammars: "`X` `:N`" (name before the pointer) and "`:N` (`X`)"
      // (name AFTER it). Only the first was implemented, and it produced confident FALSE failures:
      // `broker.ts:3676` (`canceled`) does contain `"canceled"` on that exact line, but the nearest
      // PRECEDING identifier was `timedOut`, borrowed from the previous clause `:3543` (`timedOut`),
      // so a correct pointer was reported as drift in ERROR_SOURCES.md and RETRY_OWNERS.md alike. A
      // parenthetical immediately after a pointer is the author naming what it points at, so it wins
      // over anything preceding it.
      // `raw` is the span WITHOUT its backticks, so the closing backtick sits at i + raw.length + 1.
      // Slicing one character early left `tail` starting on the backtick itself and the pattern never
      // matched -- the following-anchor silently did nothing in two full runs.
      const close = line.indexOf("`", t.i + 1);
      const tail = close >= 0 ? line.slice(close + 1) : "";
      const fm = tail.match(/^\s*\(`([^`]+)`\)/);
      if (fm) {
        // A parenthetical that is itself a citation -- "`resilienceConfig.ts:90` (`retryPolicy.ts:100`)"
        // -- names a FILE, not a symbol. Taking "retryPolicy" as the anchor of the preceding pointer
        // invented drift for a citation that was correct.
        const inner = fm[1].replace(
          /[A-Za-z0-9_./@-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|json|md|sh|py|rs|go)\b(?::\d+(?:-\d+)?)?/g,
          " ",
        );
        for (const w of inner.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) claimed.add(w);
        for (const w of inner.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
          if (fileText.includes(w)) { want = w; break; }
        }
      }
      if (!want && nearest && !claimed.has(nearest) && fileText.includes(nearest)) want = nearest;
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
        rows.push({ doc, line: idx + 1, file, raw: t.raw, cite: `${t.a}${t.b !== t.a ? `-${t.b}` : ""}`, anchor: want, found, verdict, at: (at ?? "").trim().slice(0, 110), target: found ? (lines[found - 1] ?? "").trim().slice(0, 110) : "", hint: nearestHint });
        continue;
      }
      rows.push({ doc, line: idx + 1, file, raw: t.raw, cite: `${t.a}${t.b !== t.a ? `-${t.b}` : ""}`, anchor: want, found: 0, verdict, at: (at ?? "").trim().slice(0, 110), target: "", hint: nearestHint });
    }
    // Publish this row's explicit paths to the column carry AFTER the row is judged, so a column
    // never binds against a path that appears later in its own row.
    for (const e of explicit) colCarry.set(cellOf(line, e.i), e.r);
    if (!isTable) paraCarry = cur;
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
const FAIL = ["ANCHOR_MISSING", "OUT_OF_RANGE", "NO_FILE", "BARE_AMBIGUOUS"];
// An empty sweep is never a pass. `RESULT drift=0` after judging nothing is exactly the false green
// this gate exists to catch, so it fails loudly instead of looking clean.
if (rows.length === 0) {
  console.error(`VACUOUS: ${FILES.length} document(s) scanned, 0 citations judged at ${REF}.`);
  console.error("         A sweep that judged nothing is not a pass. Check the path/dir arguments.");
  process.exit(2);
}
const isBaselined = (r) => baseline.has(r.doc);
const bad = rows.filter((r) => FAIL.includes(r.verdict) && !isBaselined(r));
const baselined = rows.filter((r) => FAIL.includes(r.verdict) && isBaselined(r));
for (const doc of baseline.keys()) {
  if (FILES.includes(doc) && !baselined.some((r) => r.doc === doc)) {
    console.log(`  BASELINE-STALE  ${doc} declares failures but has none now -- remove the entry`);
  }
}
if (json) console.log(JSON.stringify({ ref: REF, band: BAND, citations: rows.length, tally, bad, rows }, null, 2));
else {
  console.log(`ref=${REF} band=${BAND} citations=${rows.length}`);
  for (const k of ["ANCHOR_AT", "ANCHOR_NEARBY", "ANCHOR_MISSING", "BARE_AMBIGUOUS", "NO_FILE", "OUT_OF_RANGE", "NO_ANCHOR"]) {
    console.log(`  ${k.padEnd(15)}${tally[k] ?? 0}`);
  }
  console.log("  --- problems ---");
  for (const r of rows.filter((x) => x.verdict === "ANCHOR_NEARBY")) {
    console.log(`  ADVISORY(imprecise, not blocking)  ${r.doc.split("/").pop()}:${r.line}  ${r.file}:${r.cite}  anchor '${r.anchor}' is at :${r.found}`);
  }
  for (const r of bad) {
    console.log(`  ${r.verdict}  ${r.doc.split("/").pop()}:${r.line}  ${r.file ?? "?"}:${r.cite}  want=${r.anchor ?? "-"} found=${r.found || "-"}`);
    if (r.at) console.log(`      cited  ${r.at}`);
    if (r.target) console.log(`      found  ${r.target}`);
  }
  // Measured, not assumed: the ±BAND window means a pointer one line off inside a dense block is
  // ANCHOR_NEARBY and does NOT fail the gate. Off-by-one drift inside the 5-line DEFAULTS block is
  // exactly how this document first went stale, so it is printed rather than hidden -- advisory now,
  // and the number to watch if it is ever promoted to blocking.
  console.log(`RESULT drift=${bad.length} imprecise=${rows.filter((r) => r.verdict === "ANCHOR_NEARBY").length} docs=${FILES.length}`);
  if (baseline.size) {
    console.log(`NOTE ${baselined.length} failure(s) in ${baseline.size} declared point-in-time document(s) are NOT counted as drift:`);
    for (const [doc, why] of baseline) console.log(`     ${doc}  -- ${why}`);
    console.log("     Declared records are listed, never rewritten: their numbers describe the tree they ran against.");
  }
  if (docContextBindings) {
    console.log(`NOTE ${docContextBindings} ambiguous basename(s) (executor.ts -> 2 files, review.ts -> 4) were bound by a directory the document names itself; a written path always wins.`);
  }
  if ((tally.NO_ANCHOR ?? 0) > 0) {
    console.log(`NOTE ${tally.NO_ANCHOR} citation(s) were NOT judged: no symbol-shaped name adjacent to the citation.`);
    console.log("      Their `hint` field (--json) shows what the author DID name -- usually a value, flag, path or");
    console.log("      snake_case key, which containment cannot judge (see isIdent). To make such a citation");
    console.log("      judgeable, name the symbol the cited line declares.");
    console.log(`     Those are neither pass nor fail. Do not report this run as "citations verified".`);
  }
}
// NOT process.exit(): exiting right after a large stdout write races the flush, and on a pipe Node
// truncates at 64 KiB. `--json` over docs/specs lost everything past byte 65536 -- an automated consumer
// got invalid JSON, and a human piped into `grep RESULT` got NO verdict at all and could read that as a
// pass. Setting exitCode lets the process end naturally and flush completely.
process.exitCode = bad.length > 0 ? 1 : 0;
