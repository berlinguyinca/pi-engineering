import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_LAYOUT,
  MAX_WIDTH_PERCENT,
  MIN_WIDTH_PERCENT,
  PanelLayoutStore,
  stepTab,
  stepWidth,
} from "../../src/panel/layout.ts";

async function tempProfile(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-panel-layout-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("layout: width steps are clamped to the allowed band", () => {
  assert.equal(stepWidth(35, 1), 40);
  assert.equal(stepWidth(35, -1), 30);
  assert.equal(stepWidth(MAX_WIDTH_PERCENT, 1), MAX_WIDTH_PERCENT, "never past the ceiling");
  assert.equal(stepWidth(MIN_WIDTH_PERCENT, -1), MIN_WIDTH_PERCENT, "never past the floor");
});

test("layout: tabs cycle with wrap-around in both directions", () => {
  assert.equal(stepTab("files", 1), "reviews");
  assert.equal(stepTab("memory", 1), "files", "forward wraps");
  assert.equal(stepTab("files", -1), "memory", "backward wraps");
});

test("layout: a missing profile loads defaults rather than failing", async () => {
  const p = await tempProfile();
  try {
    assert.deepEqual(new PanelLayoutStore({ profileDir: p.dir }).load(), DEFAULT_LAYOUT);
  } finally {
    await p.cleanup();
  }
});

test("layout: a saved layout round-trips through the file, not just memory", async () => {
  const p = await tempProfile();
  try {
    const written = new PanelLayoutStore({ profileDir: p.dir });
    written.save({ widthPercent: 50, tab: "reviews", expanded: ["files", "run"] });
    // A SEPARATE store instance: this is the restart the acceptance criteria mean.
    const reloaded = new PanelLayoutStore({ profileDir: p.dir }).load();
    assert.equal(reloaded.widthPercent, 50);
    assert.equal(reloaded.tab, "reviews");
    assert.deepEqual(reloaded.expanded, ["files", "run"]);
  } finally {
    await p.cleanup();
  }
});

test("layout: the file is owner-only and holds no repository content", async () => {
  const p = await tempProfile();
  try {
    new PanelLayoutStore({ profileDir: p.dir }).save({ widthPercent: 40, tab: "files", expanded: [] });
    const path = join(p.dir, "engineering-panel", "layout.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const body = await readFile(path, "utf8");
    assert.doesNotMatch(body, /\//, "a path in the layout file would be repository content");
  } finally {
    await p.cleanup();
  }
});

test("layout: a corrupt file degrades to defaults instead of breaking the panel", async () => {
  const p = await tempProfile();
  try {
    await mkdir(join(p.dir, "engineering-panel"), { recursive: true });
    await writeFile(join(p.dir, "engineering-panel", "layout.json"), "{not json");
    assert.deepEqual(new PanelLayoutStore({ profileDir: p.dir }).load(), DEFAULT_LAYOUT);
  } finally {
    await p.cleanup();
  }
});

test("layout: an out-of-range persisted width is clamped on load", async () => {
  const p = await tempProfile();
  try {
    await mkdir(join(p.dir, "engineering-panel"), { recursive: true });
    await writeFile(
      join(p.dir, "engineering-panel", "layout.json"),
      JSON.stringify({ widthPercent: 500, tab: "files", expanded: [] }),
    );
    assert.equal(new PanelLayoutStore({ profileDir: p.dir }).load().widthPercent, MAX_WIDTH_PERCENT);
  } finally {
    await p.cleanup();
  }
});

test("layout: an unknown tab in the file falls back to the default tab", async () => {
  const p = await tempProfile();
  try {
    await mkdir(join(p.dir, "engineering-panel"), { recursive: true });
    await writeFile(
      join(p.dir, "engineering-panel", "layout.json"),
      JSON.stringify({ widthPercent: 35, tab: "not-a-tab", expanded: [] }),
    );
    assert.equal(new PanelLayoutStore({ profileDir: p.dir }).load().tab, DEFAULT_LAYOUT.tab);
  } finally {
    await p.cleanup();
  }
});

test("layout: an unwritable profile drops the preference without throwing", async () => {
  // A preference is never worth failing the panel for. The profile root here is
  // a regular FILE, so creating a directory under it fails with ENOTDIR — a real
  // failure mode, and one that does not involve poking a kernel filesystem.
  const p = await tempProfile();
  try {
    const notADirectory = join(p.dir, "blocker");
    await writeFile(notADirectory, "");
    const store = new PanelLayoutStore({ profileDir: notADirectory });
    assert.doesNotThrow(() => store.save({ widthPercent: 40, tab: "files", expanded: [] }));
    assert.deepEqual(store.load(), DEFAULT_LAYOUT, "and the next load still works");
  } finally {
    await p.cleanup();
  }
});
