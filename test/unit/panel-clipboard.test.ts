import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";
import { PanelState } from "../../src/panel/PanelState.ts";
import { copyToTerminal, osc52 } from "../../src/panel/clipboard.ts";

function sink() {
  const written: string[] = [];
  return { isTTY: true, write: (d: string) => written.push(d), written };
}

function workspaceState(): PanelState {
  const state = new PanelState();
  state.set({ updatedAt: 1, workspace: { files: [{ path: "src/alpha.ts", change: "modified" }] } });
  return state;
}

test("clipboard: the OSC 52 sequence carries base64 of the text", () => {
  assert.equal(osc52("hello"), `\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`);
});

test("clipboard: non-ASCII survives the encoding as UTF-8", () => {
  const seq = osc52("naïve ⚡");
  const b64 = seq.slice(seq.indexOf(";c;") + 3, -1);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "naïve ⚡");
});

test("clipboard: a copy writes the sequence and reports the action, not success", () => {
  const s = sink();
  const result = copyToTerminal("hello", s);
  assert.equal(s.written.length, 1);
  assert.equal(result.copied, true);
  // OSC 52 is write-only. Pi's own source notes that a bare write can flash
  // "Copied!" while the clipboard stays untouched, so claiming success here
  // would be a claim we have no way to make.
  assert.doesNotMatch(result.message, /copied to (the )?(system )?clipboard/i);
  assert.match(result.message, /sent/i);
});

test("clipboard: a non-TTY is a real failure and is reported as one", () => {
  const result = copyToTerminal("hello", { isTTY: false, write: () => {} });
  assert.equal(result.copied, false);
  assert.match(result.message, /not a terminal/i);
});

test("clipboard: a throwing write is reported, never propagated", () => {
  const result = copyToTerminal("hello", {
    isTTY: true,
    write: () => {
      throw new Error("EPIPE");
    },
  });
  assert.equal(result.copied, false);
  assert.match(result.message, /EPIPE/);
});

test("clipboard: y copies the selected row and Y copies the visible body", () => {
  const copied: string[] = [];
  const c = new PanelComponent({
    state: workspaceState(),
    requestRender: () => {},
    copy: (text) => {
      copied.push(text);
      return { copied: true, message: "sent to terminal clipboard" };
    },
  });
  c.render(80);
  while (c.rows[c.selectedIndex]?.payload.kind !== "file") c.handleInput("\x1b[B");
  c.handleInput("y");
  assert.match(copied[0] ?? "", /alpha\.ts/);
  assert.equal(copied[0]?.includes("\n"), false, "y copies one row");
  c.handleInput("Y");
  assert.ok((copied[1] ?? "").includes("\n"), "Y copies the body");
  c.dispose();
});

test("clipboard: the copy result is shown to the operator", () => {
  const c = new PanelComponent({
    state: workspaceState(),
    requestRender: () => {},
    copy: () => ({ copied: false, message: "not a terminal" }),
  });
  c.render(80);
  c.handleInput("y");
  assert.match(c.render(80).join("\n"), /not a terminal/);
  c.dispose();
});

test("clipboard: y during a search types into the query instead of copying", () => {
  let copies = 0;
  const c = new PanelComponent({
    state: workspaceState(),
    requestRender: () => {},
    copy: () => {
      copies++;
      return { copied: true, message: "sent" };
    },
  });
  c.render(80);
  c.handleInput("/");
  c.handleInput("y");
  assert.equal(copies, 0);
  c.dispose();
});

test("clipboard: the copied row carries no cursor or indentation artefacts", () => {
  const copied: string[] = [];
  const c = new PanelComponent({
    state: workspaceState(),
    requestRender: () => {},
    copy: (text) => {
      copied.push(text);
      return { copied: true, message: "sent" };
    },
  });
  c.render(80);
  while (c.rows[c.selectedIndex]?.payload.kind !== "file") c.handleInput("\x1b[B");
  c.handleInput("y");
  assert.equal(copied[0], "src/alpha.ts", "pasting a row must paste the value, not the drawing");
  c.dispose();
});
