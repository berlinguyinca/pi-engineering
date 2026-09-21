import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelStateShape } from "../../src/panel/PanelState.ts";
import { buildRows, clampSelection } from "../../src/panel/tree.ts";

const runState: PanelStateShape = {
  updatedAt: 1,
  errors: [],
  run: {
    workItemId: "WI-12",
    goal: "add retry to the gateway client",
    phase: "review",
    risk: "high",
    candidateId: "CAND-3",
    files: [
      { path: "src/gateway/signals.ts", change: "added" },
      { path: "extensions/index.ts", change: "modified" },
    ],
    findings: [
      {
        id: "E-1",
        severity: "high",
        claim: "retry loop can spin",
        role: "reviewer",
        model: "opus-5",
        candidateId: "CAND-3",
        status: "open",
      },
    ],
    spend: [{ model: "opus-5", input: 1000, output: 200, cost: 0.5 }],
  },
};

const allExpanded = new Set(["run", "files", "findings", "spend", "workspace"]);

test("tree: a run renders its work item, files, findings and spend across the tabs", () => {
  // Track 3 split these across tabs: each tab is a different view of one state,
  // and the run header orients every tab that describes a run.
  const labelsOn = (tab: "files" | "reviews" | "tokens") =>
    buildRows(runState, allExpanded, tab)
      .map((r) => r.label)
      .join("|");
  for (const tab of ["files", "reviews", "tokens"] as const) {
    assert.match(labelsOn(tab), /WI-12/, `${tab} tab lost the run header`);
  }
  assert.match(labelsOn("files"), /src\/gateway\/signals\.ts/);
  assert.match(labelsOn("reviews"), /retry loop can spin/);
  assert.match(labelsOn("tokens"), /opus-5/);
});

test("tree: a finding carries its severity, reviewing role and model", () => {
  const rows = buildRows(runState, allExpanded, "reviews");
  const finding = rows.find((r) => r.payload.kind === "finding");
  assert.ok(finding, "no finding row");
  assert.match(finding.label, /high/i);
  assert.match(finding.label, /reviewer/);
  assert.match(finding.label, /opus-5/);
});

test("tree: an unattributed finding renders without inventing a reviewer", () => {
  const rows = buildRows(
    {
      ...runState,
      run: {
        ...runState.run!,
        findings: [{ id: "E-2", severity: "low", claim: "nit", status: "open" }],
      },
    },
    allExpanded,
    "reviews",
  );
  const finding = rows.find((r) => r.payload.kind === "finding");
  assert.ok(finding);
  assert.match(finding.label, /nit/);
  assert.doesNotMatch(finding.label, /undefined/);
});

test("tree: collapsing a section hides its children but keeps the header", () => {
  const collapsed = new Set(["run", "findings", "spend"]); // files collapsed
  const rows = buildRows(runState, collapsed);
  assert.ok(rows.some((r) => r.payload.kind === "section" && r.payload.id === "files"));
  assert.equal(
    rows.some((r) => r.payload.kind === "file"),
    false,
  );
});

test("tree: a collapsed section header shows a closed glyph", () => {
  const open = buildRows(runState, allExpanded).find((r) => r.payload.kind === "section" && r.payload.id === "files");
  const shut = buildRows(runState, new Set(["run"])).find(
    (r) => r.payload.kind === "section" && r.payload.id === "files",
  );
  assert.notEqual(open?.glyph, shut?.glyph);
});

test("tree: section headers report their child counts", () => {
  const rows = buildRows(runState, allExpanded);
  const files = rows.find((r) => r.payload.kind === "section" && r.payload.id === "files");
  assert.match(files?.label ?? "", /2/);
});

test("tree: the idle view renders the working tree when there is no run", () => {
  const rows = buildRows(
    {
      updatedAt: 1,
      errors: [],
      workspace: {
        branch: "main",
        files: [{ path: "README.md", change: "modified" }],
        contextTokens: 1200,
        contextPercent: 12,
      },
    },
    allExpanded,
  );
  const labels = rows.map((r) => r.label).join("|");
  assert.match(labels, /README\.md/);
  assert.match(labels, /main/);
});

test("tree: an empty state says so instead of rendering nothing", () => {
  const rows = buildRows({ updatedAt: 0, errors: [] }, allExpanded);
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.payload.kind === "empty"));
});

test("tree: a section error renders as a marked row and does not hide other sections", () => {
  const rows = buildRows({ ...runState, errors: [{ section: "workspace", message: "git failed" }] }, allExpanded);
  assert.ok(rows.some((r) => r.payload.kind === "error" && /git failed/.test(r.label)));
  assert.ok(
    rows.some((r) => r.payload.kind === "file"),
    "run files must still render",
  );
});

test("tree: file rows mark how each file changed", () => {
  const rows = buildRows(runState, allExpanded);
  const added = rows.find((r) => r.payload.kind === "file" && r.payload.path.endsWith("signals.ts"));
  const modified = rows.find((r) => r.payload.kind === "file" && r.payload.path.endsWith("index.ts"));
  assert.notEqual(added?.glyph, modified?.glyph);
});

test("tree: run files and workspace files are distinguishable by source", () => {
  const rows = buildRows(
    {
      ...runState,
      workspace: { branch: "main", files: [{ path: "README.md", change: "modified" }] },
    },
    allExpanded,
  );
  const sources = rows.filter((r) => r.payload.kind === "file").map((r) => (r.payload as { source: string }).source);
  assert.ok(sources.includes("run"));
  assert.ok(sources.includes("workspace"));
});

test("tree: clampSelection keeps the cursor on a selectable row", () => {
  const rows = buildRows(runState, allExpanded);
  assert.equal(rows[clampSelection(rows, -5)]?.selectable, true);
  assert.equal(rows[clampSelection(rows, 9999)]?.selectable, true);
  assert.equal(clampSelection([], 0), -1);
});

test("tree: clampSelection skips past an unselectable row", () => {
  const rows = [
    { depth: 0, glyph: "", label: "not selectable", payload: { kind: "empty" as const }, selectable: false },
    { depth: 0, glyph: "", label: "selectable", payload: { kind: "section" as const, id: "files" }, selectable: true },
  ];
  assert.equal(clampSelection(rows, 0), 1);
});

test("tree: a state with only unselectable rows reports no selection", () => {
  const rows = buildRows({ updatedAt: 0, errors: [] }, allExpanded);
  if (!rows.some((r) => r.selectable)) assert.equal(clampSelection(rows, 0), -1);
});
