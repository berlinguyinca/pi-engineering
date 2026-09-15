import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelController, matchesChord } from "../../src/panel/PanelController.ts";
import { PanelState } from "../../src/panel/PanelState.ts";

/** A minimal ExtensionUIContext stand-in exposing only `custom`. */
function fakeUi() {
  const ui = {
    customCalls: 0,
    hideCalls: 0,
    lastOptions: undefined as { overlay?: boolean; overlayOptions?: unknown } | undefined,
    custom: (
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (v: unknown) => void) => unknown,
      options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (h: unknown) => void },
    ) => {
      ui.customCalls++;
      ui.lastOptions = options;
      factory({ requestRender: () => {} }, {}, {}, () => {});
      options?.onHandle?.({
        hide: () => ui.hideCalls++,
        setHidden: () => {},
        isHidden: () => false,
        focus: () => {},
        unfocus: () => {},
        isFocused: () => true,
        getBounds: () => undefined,
      });
      return new Promise<void>(() => {});
    },
  };
  return ui;
}

test("controller: the chord matcher claims only its own key", () => {
  assert.equal(matchesChord("\x10", "ctrl+p"), true);
  assert.equal(matchesChord("\x01", "ctrl+p"), false);
  assert.equal(matchesChord("p", "ctrl+p"), false);
  assert.equal(matchesChord("\x10", "none"), false, "a disabled chord claims nothing");
  assert.equal(matchesChord("\x10", ""), false);
});

test("controller: terminal input passes everything except the chord through", () => {
  const controller = new PanelController({ state: new PanelState(), ui: fakeUi() as never, chord: "ctrl+p" });
  assert.deepEqual(controller.handleTerminalInput("\x10"), { consume: true });
  assert.equal(controller.handleTerminalInput("hello"), undefined);
  assert.equal(controller.handleTerminalInput("\x1b[A"), undefined);
  assert.equal(controller.handleTerminalInput("\r"), undefined);
  controller.dispose();
});

test("controller: a disabled chord never consumes input", () => {
  const controller = new PanelController({ state: new PanelState(), ui: fakeUi() as never, chord: "none" });
  assert.equal(controller.handleTerminalInput("\x10"), undefined);
  assert.equal(controller.isOpen(), false);
  controller.dispose();
});

test("controller: toggle opens and closes the overlay exactly once each way", () => {
  const ui = fakeUi();
  const controller = new PanelController({ state: new PanelState(), ui: ui as never, chord: "ctrl+p" });
  assert.equal(controller.isOpen(), false);

  controller.toggle();
  assert.equal(controller.isOpen(), true);
  assert.equal(ui.customCalls, 1);

  controller.toggle();
  assert.equal(controller.isOpen(), false);
  assert.equal(ui.hideCalls, 1);
  controller.dispose();
});

test("controller: the overlay is right-anchored and suppressed on narrow terminals", () => {
  const ui = fakeUi();
  const controller = new PanelController({ state: new PanelState(), ui: ui as never, chord: "ctrl+p" });
  controller.toggle();

  const options = ui.lastOptions as { overlay?: boolean; overlayOptions?: () => Record<string, unknown> } | undefined;
  assert.equal(options?.overlay, true);
  const overlay = options?.overlayOptions?.();
  assert.equal(overlay?.anchor, "top-right");
  const visible = overlay?.visible as ((w: number, h: number) => boolean) | undefined;
  assert.equal(visible?.(80, 40), false, "a narrow terminal must not be crowded");
  assert.equal(visible?.(160, 40), true);
  controller.dispose();
});

test("controller: the hotkey toggles the panel", () => {
  const ui = fakeUi();
  const controller = new PanelController({ state: new PanelState(), ui: ui as never, chord: "ctrl+p" });
  controller.handleTerminalInput("\x10");
  assert.equal(controller.isOpen(), true);
  controller.handleTerminalInput("\x10");
  assert.equal(controller.isOpen(), false);
  controller.dispose();
});

test("controller: dispose hides an open overlay", () => {
  const ui = fakeUi();
  const controller = new PanelController({ state: new PanelState(), ui: ui as never, chord: "ctrl+p" });
  controller.toggle();
  controller.dispose();
  assert.equal(ui.hideCalls, 1);
  assert.equal(controller.isOpen(), false);
});

test("controller: opening is announced so a feeder can refresh", () => {
  const ui = fakeUi();
  let opens = 0;
  const controller = new PanelController({
    state: new PanelState(),
    ui: ui as never,
    chord: "ctrl+p",
    onOpen: () => opens++,
  });
  controller.toggle();
  assert.equal(opens, 1);
  controller.toggle();
  assert.equal(opens, 1, "closing must not announce an open");
  controller.dispose();
});
