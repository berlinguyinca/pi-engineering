/**
 * The panel's colour scheme.
 *
 * Two invariants, and they are the reason this is a separate module rather than
 * a few `theme.fg` calls inside the renderer:
 *
 *   1. Colour never changes text. The panel's contract is one line per row at
 *      most `width` columns; a painter that inserted or dropped a visible
 *      character would corrupt the frame rather than decorate it.
 *   2. Tones are semantic, never chromatic. Shaping says `removed`, the theme
 *      says what colour that is — a hardcoded red is wrong the moment the
 *      operator switches to a light theme.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";
import { PanelState } from "../../src/panel/PanelState.ts";
import { paintGlyph, paintLabel } from "../../src/panel/rowPaint.ts";
import { type RowTone, buildRows, renderTabBar } from "../../src/panel/tree.ts";

/** Records which theme colour each fragment was painted with. */
function spyTheme() {
  const used: Array<{ colour: string; text: string }> = [];
  return {
    used,
    fg(colour: string, text: string) {
      used.push({ colour, text });
      return `<${colour}>${text}</>`;
    },
    getBgAnsi(colour: string) {
      return `<bg:${colour}>`;
    },
  };
}

/** The visible text, with the spy's markup removed. */
function plainOf(painted: string): string {
  return painted.replaceAll(/<\/?[^>]*>/g, "");
}

const ALL_TONES: RowTone[] = [
  "section",
  "added",
  "modified",
  "removed",
  "renamed",
  "commit",
  "high",
  "medium",
  "low",
  "ok",
  "note",
  "error",
];

test("paint: no tone loses or invents a character", () => {
  const theme = spyTheme();
  for (const tone of ALL_TONES) {
    for (const label of [
      "src/panel/tree.ts +31 -4",
      "assets/logo.png (binary)",
      "2efa2d3 tint the panel · 14 minutes ago",
      "Working tree · main +75 -2 (4)",
      "HIGH · reviewer · opus-5 · retry loop can spin",
      "",
    ]) {
      assert.equal(plainOf(paintLabel(label, tone, theme)), label, `${tone} changed "${label}"`);
    }
  }
});

test("paint: a file's marker takes the colour its change means", () => {
  const theme = spyTheme();
  // The conventional git scheme: added green, modified amber, deleted red,
  // renamed accent. Not a palette of our own — a tree with a private colour
  // language is one the operator has to learn.
  assert.equal(paintGlyph("A", "added", theme), "<success>A</>");
  assert.equal(paintGlyph("M", "modified", theme), "<warning>M</>");
  assert.equal(paintGlyph("D", "removed", theme), "<error>D</>");
  assert.equal(paintGlyph("R", "renamed", theme), "<accent>R</>");
  assert.equal(paintGlyph("✗", "high", theme), "<error>✗</>");
  assert.equal(paintGlyph("✓", "ok", theme), "<success>✓</>");
});

test("paint: change counts take the diff colours, not the row's", () => {
  const theme = spyTheme();
  const painted = paintLabel("src/panel/tree.ts +31 -4", "modified", theme);
  assert.equal(painted, "src/panel/tree.ts<toolDiffAdded> +31</><toolDiffRemoved> -4</>");
  // The PATH is left in the panel's default colour on purpose: colouring every
  // word by its row's tone turns a file list into a rainbow and stops the
  // marker column — where the meaning actually is — from standing out.
  assert.ok(!painted.startsWith("<"), "the path is not repainted");
});

test("paint: a path that contains +N -N is not mistaken for a count", () => {
  const theme = spyTheme();
  // Anchored to the end of the label, which is the only place a count appears.
  assert.equal(paintLabel("src/a +1 -2/b.ts", "modified", theme), "src/a +1 -2/b.ts");
});

test("paint: a commit reads sha · subject · age, loudest in the middle", () => {
  const theme = spyTheme();
  const painted = paintLabel("2efa2d3 tint the panel · 14 minutes ago", "commit", theme);
  assert.equal(painted, "<accent>2efa2d3</> tint the panel<dim> · 14 minutes ago</>");
});

test("paint: a theme that rejects a colour does not take the frame down", () => {
  const hostile = {
    fg() {
      throw new Error("unknown colour");
    },
  };
  assert.equal(paintGlyph("M", "modified", hostile), "M");
  assert.equal(paintLabel("src/a.ts +1 -0", "modified", hostile), "src/a.ts +1 -0");
});

test("paint: the tab bar marks the active tab and quiets the rest", () => {
  const theme = spyTheme();
  const bar = renderTabBar("reviews", 60, theme);
  assert.ok(bar.includes("<accent>[Reviews]</>"), "the active tab is the accent");
  assert.ok(bar.includes("<dim>"), "the others recede");
  assert.equal(plainOf(bar), renderTabBar("reviews", 60), "colour did not change the text");
});

test("paint: a tab bar too narrow to hold the active token still paints something", () => {
  const theme = spyTheme();
  for (const width of [0, 3, 8, 14]) {
    const bar = renderTabBar("memory", width, theme);
    assert.ok(visibleWidth(plainOf(bar)) <= width, `width ${width} exceeded`);
  }
});

function seeded(): PanelState {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    workspace: {
      branch: "main",
      files: [
        { path: "src/a.ts", change: "modified", added: 3, removed: 1 },
        { path: "src/b.ts", change: "deleted", added: 0, removed: 9 },
      ],
    },
  });
  return state;
}

test("component: painting never breaks the width contract", () => {
  const theme = spyTheme();
  // The spy's markup is not zero-width, so the component is measured with a
  // theme whose output IS zero-width — colour must cost no columns.
  const invisible = { fg: (_c: string, t: string) => t, getBgAnsi: () => "" };
  for (const width of [8, 20, 36, 40, 80, 200]) {
    const component = new PanelComponent({
      state: seeded(),
      requestRender: () => {},
      fillHeight: () => 16,
      theme: invisible,
    });
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
    }
    component.dispose();
  }
  assert.equal(theme.used.length, 0);
});

test("component: the cursor's row carries the selection background, full width", () => {
  const component = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    fillHeight: () => 10,
    theme: spyTheme(),
  });
  const lines = component.render(50);
  const selected = lines.filter((line) => line.includes("<bg:selectedBg>"));
  assert.equal(selected.length, 1, "exactly one row is the cursor's");
  // Re-armed after every reset, so the highlight survives the coloured tokens
  // inside the row and reaches the padding at the end — a highlight that
  // stopped at the last character would read as a stray coloured word.
  assert.ok((selected[0]?.match(/<bg:selectedBg>/g) ?? []).length > 1, "the background is re-armed across the row");
  for (const line of lines) {
    if (line === selected[0]) continue;
    assert.ok(line.includes("<bg:customMessageBg>"), "every other row keeps the panel's own surface");
  }
  component.dispose();
});

test("component: an open file has no tree cursor to highlight", () => {
  const component = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    fillHeight: () => 10,
    theme: spyTheme(),
  });
  component.render(50); // tree first, so a stale selection would linger
  component.showContent({ title: "src/a.ts", lines: ["const a = 1;"], truncated: false });
  const lines = component.render(50);
  assert.ok(!lines.some((line) => line.includes("<bg:selectedBg>")), "no row is selected in a file view");
  component.dispose();
});

test("shaping: every row that means something carries a tone", () => {
  const rows = buildRows(seeded().snapshot, new Set(["workspace"]), "files");
  const files = rows.filter((row) => row.payload.kind === "file");
  assert.deepEqual(
    files.map((row) => row.tone),
    ["modified", "removed"],
  );
  assert.equal(rows.find((row) => row.payload.kind === "section")?.tone, "section");
});
