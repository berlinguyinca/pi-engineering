/**
 * Where the panel sits, and how tall it is.
 *
 * These two numbers are ONE decision. A uniform `margin: 1` left a one-cell
 * gutter down the right and a blank row at each end, and the transcript
 * underneath showed through them: the chat's own full-width rules poked out
 * past the panel as stray coloured stubs at exactly the rows those rules
 * occupied. Zeroing the margin without growing `fillHeight` rebuilds the same
 * artifact two rows lower, so both are pinned here together.
 *
 * The position arithmetic mirrored below is pi-tui's own
 * (`resolveOverlayLayout`, dist/tui.js): width parses against the terminal and
 * is clamped to the space margins leave, then `top-right` puts the panel's
 * right edge at `marginLeft + availWidth`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelController } from "../../src/panel/PanelController.ts";
import { PanelState } from "../../src/panel/PanelState.ts";

interface Overlay {
  options: Record<string, unknown>;
  render: (width: number) => string[];
}

/** Drive the controller far enough to hold its overlay options and component. */
function openOverlay(termWidth: number, termHeight: number): Overlay {
  let captured: Overlay | undefined;
  const ui = {
    custom: (
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (v: unknown) => void) => unknown,
      opts?: { overlayOptions?: () => Record<string, unknown>; onHandle?: (h: unknown) => void },
    ) => {
      const component = factory({ requestRender: () => {} }, undefined, {}, () => {}) as {
        render: (w: number) => string[];
      };
      const options = opts?.overlayOptions?.() ?? {};
      // Pi calls `visible` every render cycle; it is the only place a component
      // ever learns the terminal HEIGHT, since `render` is given width alone.
      (options.visible as (w: number, h: number) => boolean)?.(termWidth, termHeight);
      captured = { options, render: (w) => component.render(w) };
      return new Promise<void>(() => {});
    },
  };
  const state = new PanelState();
  state.set({ updatedAt: 1, workspace: { branch: "main", files: [] } });
  new PanelController({ state, ui: ui as never }).restore();
  assert.ok(captured, "the overlay should have been built");
  return captured;
}

/** pi-tui's own layout arithmetic, for the fields the panel sets. */
function resolve(options: Record<string, unknown>, termWidth: number, termHeight: number, height: number) {
  const m = options.margin as { top: number; right: number; bottom: number; left: number };
  const availWidth = Math.max(1, termWidth - m.left - m.right);
  const availHeight = Math.max(1, termHeight - m.top - m.bottom);
  const percent = Number.parseFloat(String(options.width).replace("%", "")) / 100;
  let width = Math.round(termWidth * percent);
  width = Math.max(width, options.minWidth as number);
  width = Math.max(1, Math.min(width, availWidth));
  const col = Math.max(m.left, Math.min(m.left + availWidth - width, termWidth - m.right - width));
  const row = Math.max(m.top, Math.min(m.top, termHeight - m.bottom - height));
  return { row, col, width, availHeight };
}

test("geometry: the panel is flush with the right edge, leaving no gutter to bleed through", () => {
  for (const [termWidth, termHeight] of [
    [120, 40],
    [200, 60],
    [100, 24],
    [320, 90],
  ] as const) {
    const overlay = openOverlay(termWidth, termHeight);
    const height = overlay.render(40).length;
    const { col, width } = resolve(overlay.options, termWidth, termHeight, height);
    assert.equal(col + width, termWidth, `a gutter at ${termWidth}x${termHeight} is where the artifacts came from`);
  }
});

test("geometry: the panel fills the terminal from the first row to the last", () => {
  for (const [termWidth, termHeight] of [
    [120, 40],
    [200, 60],
    [100, 24],
  ] as const) {
    const overlay = openOverlay(termWidth, termHeight);
    const lines = overlay.render(40);
    assert.equal(lines.length, termHeight, `the panel must be exactly as tall as the terminal at ${termHeight} rows`);
    const { row } = resolve(overlay.options, termWidth, termHeight, lines.length);
    assert.equal(row, 0, "and it must start at the top row");
    assert.equal(row + lines.length, termHeight, "and end at the bottom one");
  }
});

test("geometry: only the left margin is non-zero", () => {
  const { options } = openOverlay(160, 48);
  assert.deepEqual(options.margin, { top: 0, right: 0, bottom: 0, left: 1 });
  assert.equal(options.anchor, "top-right");
  assert.equal(options.nonCapturing, true, "an always-on panel that takes the keyboard is a broken pi");
});

test("geometry: the panel stays hidden on a terminal too narrow to share", () => {
  const { options } = openOverlay(160, 48);
  const visible = options.visible as (w: number, h: number) => boolean;
  assert.equal(visible(80, 40), false);
  assert.equal(visible(160, 40), true);
});
