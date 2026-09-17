/**
 * The hint that says which key steps into the panel.
 *
 * The panel is registered `nonCapturing`, so it is on screen and inert until
 * the chord is pressed. Without a hint that reads as a broken panel — arrows
 * move the prompt's history, enter sends a message, and nothing about the
 * picture says why. The rule this pins is that the hint costs no content: it
 * overwrites a row, it never adds one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";
import { PanelState } from "../../src/panel/PanelState.ts";

function seeded(): PanelState {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    workspace: { branch: "main", files: [], recentCommits: [{ sha: "abc1234", subject: "a commit", relative: "now" }] },
  });
  return state;
}

function build(
  opts: { focused?: boolean; chord?: string; toggleChord?: string; height?: number } = {},
): PanelComponent {
  return new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    fillHeight: () => opts.height ?? 20,
    ...(opts.chord === undefined ? { chord: "ctrl+p" } : { chord: opts.chord }),
    ...(opts.toggleChord === undefined ? { toggleChord: "ctrl+b" } : { toggleChord: opts.toggleChord }),
    focused: () => opts.focused === true,
  });
}

test("hint: an unfocused panel names the chords that step in and hide it", () => {
  const component = build();
  const lines = component.render(60);
  assert.match(lines[lines.length - 1] ?? "", /ctrl\+p to navigate/);
  assert.match(lines[lines.length - 1] ?? "", /ctrl\+b hide/);
  component.dispose();
});

test("hint: a disabled toggle chord is left out of the hint", () => {
  const component = build({ toggleChord: "none" });
  const last = component.render(60).at(-1) ?? "";
  assert.match(last, /ctrl\+p to navigate/);
  assert.ok(!last.includes("hide"), "no toggle chord, nothing to name");
  component.dispose();
});

test("hint: a focused panel names the keys instead", () => {
  const component = build({ focused: true });
  const last = component.render(60).at(-1) ?? "";
  assert.ok(!last.includes("ctrl+p"), "already inside: the chord is no longer the answer");
  assert.match(last, /move/);
  assert.match(last, /esc/);
  component.dispose();
});

test("hint: it overwrites the last row rather than adding one", () => {
  const height = 20;
  const withHint = build({ height }).render(60);
  const withoutHint = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    fillHeight: () => height,
  }).render(60);
  assert.equal(withHint.length, withoutHint.length, "the hint must not cost a row");
  assert.equal(withHint.length, height, "and the panel still fills the height it was given");
});

test("hint: a disabled chord produces no hint at all", () => {
  const component = build({ chord: "none" });
  const last = component.render(60).at(-1) ?? "";
  assert.ok(!last.includes("navigate"), "nothing to press, nothing to say");
  component.dispose();
});

test("hint: a component with no focus resolver is unchanged", () => {
  // Older wiring, and every headless test: absent means silent, not a crash
  // and not a hint claiming a chord the caller never configured.
  const component = new PanelComponent({ state: seeded(), requestRender: () => {}, fillHeight: () => 20 });
  const last = component.render(60).at(-1) ?? "";
  assert.ok(!last.includes("navigate"));
  component.dispose();
});

test("hint: it disappears while a file is open", () => {
  const component = build();
  component.showContent({ title: "src/a.ts", lines: ["const a = 1;"], truncated: false });
  const last = component.render(60).at(-1) ?? "";
  assert.ok(!last.includes("navigate"), "arrows already do something here");
  component.dispose();
});

test("hint: it still respects the width contract when the panel is narrow", () => {
  for (const width of [12, 20, 36, 80]) {
    const component = build({ focused: true });
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
    }
    component.dispose();
  }
});
