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

/**
 * A theme whose output is ZERO WIDTH, as a real one is.
 *
 * `spyTheme` is right for asserting which colour a fragment got and wrong for
 * anything that renders a whole line: its markup is ordinary characters, so it
 * consumes columns and the width clamp truncates it. Real escape sequences cost
 * nothing, so these carry distinct SGR codes that are still identifiable in the
 * output.
 */
const BG_CODE: Record<string, string> = { selectedBg: "48;5;17", customMessageBg: "48;5;18" };

function ansiTheme() {
  const esc = String.fromCharCode(27);
  return {
    fg: (_colour: string, text: string) => `${esc}[38;5;110m${text}${esc}[0m`,
    getBgAnsi: (colour: string) => `${esc}[${BG_CODE[colour] ?? "48;5;19"}m`,
  };
}

/** Does this rendered line carry the given background? */
function hasBg(line: string, colour: string): boolean {
  return line.includes(`${String.fromCharCode(27)}[${BG_CODE[colour]}m`);
}

/** How many times the background was re-armed across the line. */
function bgCount(line: string, colour: string): number {
  return line.split(`${String.fromCharCode(27)}[${BG_CODE[colour]}m`).length - 1;
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
    theme: ansiTheme(),
  });
  const lines = component.render(50);
  const selected = lines.filter((line) => hasBg(line, "selectedBg"));
  assert.equal(selected.length, 1, "exactly one row is the cursor's");
  // Re-armed after every reset, so the highlight survives the coloured tokens
  // inside the row and reaches the padding at the end — a highlight that
  // stopped at the last character would read as a stray coloured word.
  assert.ok(bgCount(selected[0] ?? "", "selectedBg") > 1, "the background is re-armed across the row");
  for (const line of lines) {
    if (line === selected[0]) continue;
    assert.ok(hasBg(line, "customMessageBg"), "every other row keeps the panel's own surface");
  }
  component.dispose();
});

test("component: an open file has no tree cursor to highlight", () => {
  const component = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    fillHeight: () => 10,
    theme: ansiTheme(),
  });
  component.render(50); // tree first, so a stale selection would linger
  component.showContent({ title: "src/a.ts", lines: ["const a = 1;"], truncated: false });
  const lines = component.render(50);
  assert.ok(!lines.some((line) => hasBg(line, "selectedBg")), "no row is selected in a file view");
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

function manyRows(count: number): PanelState {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    narrative: { text: "Working through the panel's rendering.", updatedAt: 1, generated: true },
    workspace: {
      branch: "main",
      files: Array.from({ length: count }, (_, i) => ({ path: `src/f${i}.ts`, change: "modified" as const })),
    },
  });
  return state;
}

test("component: a cursor below the fold highlights nothing, not the summary", () => {
  // Both render paths clip — `padToHeight` to the terminal, the split to
  // whatever the narrative leaves — so a selection scrolled past the bottom has
  // an index that refers to a line the tree no longer occupies. In the split
  // that line belongs to the SUMMARY, and the highlight would land on generated
  // prose while the cursor sat somewhere else entirely.
  const component = new PanelComponent({
    state: manyRows(40),
    requestRender: () => {},
    fillHeight: () => 18,
    theme: ansiTheme(),
  });
  for (let i = 0; i < 39; i++) component.handleInput("\x1b[B");
  const lines = component.render(50);
  assert.equal(lines.length, 18, "the panel still fills its column");
  assert.equal(
    lines.filter((line) => hasBg(line, "selectedBg")).length,
    0,
    "an off-screen cursor highlights no row at all",
  );
  component.dispose();
});

test("component: a cursor inside the tree pane still highlights, with a summary below", () => {
  const component = new PanelComponent({
    state: manyRows(40),
    requestRender: () => {},
    fillHeight: () => 18,
    theme: ansiTheme(),
  });
  component.handleInput("\x1b[B");
  const lines = component.render(50);
  const at = lines.findIndex((line) => hasBg(line, "selectedBg"));
  assert.ok(at >= 0, "a visible cursor is still drawn");
  assert.ok(at < 12, "and it is in the tree pane, not the summary");
  component.dispose();
});

test("component: the width contract holds for wide characters and degenerate widths", () => {
  // Two escapes from one rule, both found by a fresh review: the narrative pane
  // never went through the inner truncation, and below width 2 the border's own
  // two columns exceed the panel. Proven before the fix: render(20) returned a
  // 38-column line, render(1) a 2-column one.
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    narrative: { text: `${"漢".repeat(50)} ${"😀".repeat(20)}`, updatedAt: 1, generated: true },
    workspace: {
      branch: "main",
      files: [{ path: "src/日本語/ファイル.ts", change: "modified", added: 3, removed: 1 }],
    },
  });
  for (const width of [0, 1, 2, 3, 20, 40, 60, 80]) {
    const component = new PanelComponent({
      state,
      requestRender: () => {},
      fillHeight: () => 20,
      theme: { fg: (_c: string, t: string) => t, getBgAnsi: () => "" },
    });
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `render(${width}) returned ${visibleWidth(line)} columns`);
    }
    component.dispose();
  }
});

test("component: one throwing theme colour costs a colour, not the panel", () => {
  // `render`'s own catch returns an EMPTY panel, so an unguarded theme call
  // anywhere in it takes the tree, the summary and the border down together —
  // hiding everything the operator was reading, to report a colour that could
  // have been skipped.
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    narrative: { text: "a summary of the work", updatedAt: 1, generated: true },
    workspace: { branch: "main", files: [{ path: "src/a.ts", change: "modified" }] },
  });
  const component = new PanelComponent({
    state,
    requestRender: () => {},
    fillHeight: () => 20,
    theme: {
      fg() {
        throw new Error("theme is broken");
      },
    },
  });
  const lines = component.render(50);
  assert.equal(lines.length, 20, "the panel still fills its column");
  assert.ok(
    lines.some((line) => line.includes("src/a.ts")),
    "and still shows the tree",
  );
  assert.ok(
    lines.some((line) => line.includes("a summary of the work")),
    "and still shows the summary",
  );
  component.dispose();
});

test("shaping: a run's files say the ledger recorded a change, not what it was", () => {
  // `changed_files` is a list of PATHS, so a run's files genuinely have no
  // change kind. Reporting them as "modified" put a fact on screen that nothing
  // had observed — the read model inventing one, which it may never do.
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    run: {
      workItemId: "WI-1",
      goal: "add retry to the gateway client",
      phase: "review",
      risk: "low",
      files: [{ path: "src/a.ts", change: "changed" }],
      findings: [],
      spend: [],
    },
  });
  const rows = buildRows(state.snapshot, new Set(["files"]), "files");
  const file = rows.find((row) => row.payload.kind === "file");
  assert.equal(file?.glyph, "·", "a neutral bullet: every letter in that column is a claim");
  assert.equal(file?.tone, "note", "and no colour that would imply one");
});
