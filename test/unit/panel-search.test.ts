import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";
import { PanelState } from "../../src/panel/PanelState.ts";
import { findMatches, stepMatch } from "../../src/panel/search.ts";

const rows = [
  { label: "src/gateway/signals.ts" },
  { label: "src/panel/Search.ts" },
  { label: "README.md" },
  { label: "src/gateway/config.ts" },
];

/** Two files, both expanded, so the component has selectable rows to search. */
function workspaceState(): PanelState {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    workspace: {
      files: [
        { path: "src/alpha.ts", change: "modified" },
        { path: "src/beta.ts", change: "modified" },
      ],
    },
  });
  return state;
}

test("search: a lowercase query is case-insensitive (smartcase)", () => {
  assert.deepEqual(findMatches(rows, "search"), [1]);
});

test("search: any uppercase in the query makes the match exact", () => {
  assert.deepEqual(findMatches(rows, "Search"), [1]);
  assert.deepEqual(findMatches(rows, "SEARCH"), []);
});

test("search: every matching row is returned, in order", () => {
  assert.deepEqual(findMatches(rows, "gateway"), [0, 3]);
});

test("search: an empty query matches nothing rather than everything", () => {
  assert.deepEqual(findMatches(rows, ""), []);
  assert.deepEqual(findMatches(rows, "   "), []);
});

test("search: a query with regex metacharacters is matched literally", () => {
  // A user typing "config.ts" must not have "." treated as any-character.
  assert.deepEqual(findMatches([{ label: "configXts" }, { label: "config.ts" }], "config.ts"), [1]);
});

test("search: n and N wrap around in both directions", () => {
  const matches = [0, 3];
  assert.equal(stepMatch(matches, 0, 1), 1);
  assert.equal(stepMatch(matches, 1, 1), 0, "forward wraps");
  assert.equal(stepMatch(matches, 0, -1), 1, "backward wraps");
});

test("search: stepping an empty match list yields -1, never a crash", () => {
  assert.equal(stepMatch([], 0, 1), -1);
});

test("search: / opens a prompt, typing filters, and enter jumps to the first match", () => {
  const c = new PanelComponent({ state: workspaceState(), requestRender: () => {} });
  c.render(80);
  c.handleInput("/");
  for (const ch of "beta") c.handleInput(ch);
  assert.match(c.render(80).join("\n"), /\/beta/, "the query is shown while typing");
  c.handleInput("\r");
  assert.match(c.rows[c.selectedIndex]?.label ?? "", /beta/);
  c.dispose();
});

test("search: n steps to the next match after committing a search", () => {
  const c = new PanelComponent({ state: workspaceState(), requestRender: () => {} });
  c.render(80);
  c.handleInput("/");
  for (const ch of "src") c.handleInput(ch);
  c.handleInput("\r");
  const first = c.selectedIndex;
  c.handleInput("n");
  assert.notEqual(c.selectedIndex, first, "n must move to the next match");
  c.handleInput("N");
  assert.equal(c.selectedIndex, first, "N returns to it");
  c.dispose();
});

test("search: escape cancels the search and restores the prior selection", () => {
  const c = new PanelComponent({ state: workspaceState(), requestRender: () => {} });
  c.render(80);
  const before = c.selectedIndex;
  c.handleInput("/");
  for (const ch of "beta") c.handleInput(ch);
  c.handleInput("\x1b");
  assert.equal(c.selectedIndex, before, "a cancelled search must not move the cursor");
  // Anchored to the prompt line: "/beta" also occurs inside the path src/beta.ts.
  assert.equal(
    c.render(80).some((line) => line.startsWith("/")),
    false,
    "the prompt line must be gone",
  );
  c.dispose();
});

test("search: escape during a search closes the search, not the panel", () => {
  let closed = 0;
  const c = new PanelComponent({ state: workspaceState(), requestRender: () => {}, onClose: () => closed++ });
  c.render(80);
  c.handleInput("/");
  c.handleInput("\x1b");
  assert.equal(closed, 0, "the first escape belongs to the search");
  c.handleInput("\x1b");
  assert.equal(closed, 1, "the second closes the panel");
  c.dispose();
});

test("search: backspace edits the query", () => {
  const c = new PanelComponent({ state: workspaceState(), requestRender: () => {} });
  c.render(80);
  c.handleInput("/");
  for (const ch of "abc") c.handleInput(ch);
  c.handleInput("\x7f");
  // The panel draws a left border, so the prompt is inside the frame rather
  // than at column zero.
  const prompt = c.render(80).find((line) => line.includes("/ab"));
  assert.ok(prompt, "the search prompt should be rendered");
  assert.match(prompt, /│\s+\/ab\s*$/, "the query follows the border");
  c.dispose();
});

test("search: a search that matches nothing leaves the selection alone", () => {
  const c = new PanelComponent({ state: workspaceState(), requestRender: () => {} });
  c.render(80);
  const before = c.selectedIndex;
  c.handleInput("/");
  for (const ch of "zzzz") c.handleInput(ch);
  c.handleInput("\r");
  assert.equal(c.selectedIndex, before);
  c.dispose();
});

test("search: typing a tab character during a search does not change tab", () => {
  // While searching, keys belong to the query, not to navigation.
  const c = new PanelComponent({ state: workspaceState(), requestRender: () => {} });
  c.render(80);
  c.handleInput("/");
  c.handleInput("\t");
  assert.equal(c.tab, "files");
  c.dispose();
});
