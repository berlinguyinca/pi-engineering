/**
 * The always-visible summary line.
 *
 * This exists because the panel cannot be always-visible: `ctx.ui.custom()`
 * takes keyboard focus, so a permanently-open panel is a session that accepts
 * no typing. The footer takes no focus, so persistent awareness lives there and
 * pays for it by being a line rather than a pane.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelState } from "../../src/panel/PanelState.ts";
import { renderAmbient } from "../../src/status/ambient.ts";

function stateWith(patch: Parameters<PanelState["set"]>[0]): PanelState {
  const s = new PanelState();
  s.set({ updatedAt: 1, ...patch });
  return s;
}

const RUN = {
  workItemId: "wi-1",
  goal: "g",
  phase: "verifying",
  risk: "medium",
  files: [
    { path: "a.ts", change: "modified" as const },
    { path: "b.ts", change: "added" as const },
  ],
  findings: [],
  spend: [{ model: "deepseek-v4-flash", input: 55_447, output: 23_739, cost: 0 }],
};

test("ambient: an idle session gets no row at all", () => {
  // A footer row that is always present but usually blank costs a line of
  // terminal for nothing, and the operator stops reading the area entirely.
  assert.equal(renderAmbient(new PanelState().snapshot), undefined);
});

test("ambient: a run is summarised in one line", () => {
  const line = renderAmbient(stateWith({ run: RUN }).snapshot);
  assert.ok(line);
  assert.match(line, /verifying/);
  assert.match(line, /2 files/);
  assert.match(line, /79\.2k tok/);
});

test("ambient: the worst severity is named, not just the count", () => {
  // "3 findings" reads identically whether they are informational or one is
  // critical, which is the case the operator most needs to see.
  const line = renderAmbient(
    stateWith({
      run: {
        ...RUN,
        findings: [
          { id: "1", severity: "low", claim: "x", status: "open" },
          { id: "2", severity: "critical", claim: "y", status: "open" },
          { id: "3", severity: "medium", claim: "z", status: "open" },
        ],
      },
    }).snapshot,
  );
  assert.match(line ?? "", /3 findings \(critical\)/);
});

test("ambient: findings with nothing loud carry no severity", () => {
  const line = renderAmbient(
    stateWith({ run: { ...RUN, findings: [{ id: "1", severity: "info", claim: "x", status: "open" }] } }).snapshot,
  );
  assert.match(line ?? "", /1 findings$|1 findings ·/);
  assert.doesNotMatch(line ?? "", /\(critical\)|\(high\)|\(medium\)/);
});

test("ambient: the working tree stands in when no run is active", () => {
  const line = renderAmbient(
    stateWith({ workspace: { branch: "main", files: [{ path: "x.ts", change: "modified" }] } }).snapshot,
  );
  assert.match(line ?? "", /1 file\b/, "singular, because one file is not 1 files");
});

test("ambient: an unreadable source is said out loud", () => {
  // A summary that silently omits a section it could not read is
  // indistinguishable from one where nothing happened.
  const s = stateWith({ run: RUN });
  s.noteError("run", "no ledger for this repo");
  assert.match(renderAmbient(s.snapshot) ?? "", /1 source\(s\) unavailable/);
});

test("ambient: token counts stay compact at every magnitude", () => {
  const at = (input: number) =>
    renderAmbient(stateWith({ run: { ...RUN, spend: [{ model: "m", input, output: 0, cost: 0 }] } }).snapshot) ?? "";
  assert.match(at(940), /940 tok/);
  assert.match(at(79_186), /79\.2k tok/);
  assert.match(at(2_400_000), /2\.4M tok/);
});

test("ambient: zero spend adds no token fragment", () => {
  const line = renderAmbient(
    stateWith({ run: { ...RUN, spend: [{ model: "m", input: 0, output: 0, cost: 0 }] } }).snapshot,
  );
  assert.doesNotMatch(line ?? "", /tok/);
});
