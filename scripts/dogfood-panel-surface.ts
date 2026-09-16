#!/usr/bin/env node
/**
 * Panel-surface dogfood: render against Pi's REAL `Theme`, and prove nothing
 * writes to the terminal behind the TUI's back.
 *
 * Every panel test uses a theme stub, which is the right tool for asking "did
 * this fragment get the success colour" and the wrong one for asking "does this
 * frame survive a real terminal". A stub's markup occupies columns; real escape
 * sequences occupy none, and the entire width contract rests on that. The two
 * defects this branch shipped were both of that shape:
 *
 *   * a narrative pane returning 38 columns for a 20-column panel, because the
 *     wrapper measured UTF-16 units rather than display columns;
 *   * six subsystems writing diagnostics straight to stderr, landing under a
 *     frame the TUI had drawn and scrolling it by a row the TUI did not know
 *     about.
 *
 * Neither was reachable from a unit test. Both are checked here.
 *
 * Deterministic: no network, no model call.
 *
 *   node scripts/dogfood-panel-surface.ts [--verbose]
 */
import { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describeAdmissionEvent } from "../src/gateway/admissionNotice.ts";
import { PanelComponent } from "../src/panel/PanelComponent.ts";
import { PanelState } from "../src/panel/PanelState.ts";
import { emitTelemetry, setTelemetrySink } from "../src/telemetry/sink.ts";

const verbose = process.argv.includes("--verbose");
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

const ESC = String.fromCharCode(27);
/** A full reset, which clears the background as well as the foreground. */
const RESET = `${ESC}[0m`;

/** Pi's real Theme, built directly so this needs no interactive session. */
function realTheme(mode: "truecolor" | "256color"): Theme {
  const colours = [
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "searchMatchText",
    "userMessageText",
    "customMessageText",
    "customMessageLabel",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "bashMode",
  ];
  const backgrounds = [
    "selectedBg",
    "searchMatchBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
  ];
  const fg = Object.fromEntries(colours.map((c, i) => [c, `#${(0x303030 + i * 0x040201).toString(16).slice(-6)}`]));
  const bg = Object.fromEntries(backgrounds.map((c, i) => [c, `#${(0x101010 + i * 0x020202).toString(16).slice(-6)}`]));
  return new Theme(fg as never, bg as never, mode);
}

/** A panel carrying every shape that has caused trouble. */
function loadedState(): PanelState {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    narrative: {
      // Wide characters and emoji: the narrative is model-generated prose, so
      // it is the text most likely to contain them.
      text: `Reviewed ${"漢字".repeat(20)} and shipped ${"🎉".repeat(10)} across a very long sentence that must wrap.`,
      updatedAt: 1,
      generated: true,
    },
    run: {
      workItemId: "WI-12",
      goal: "stop a saturated gateway from killing the interactive turn",
      phase: "review",
      risk: "high",
      files: [{ path: "src/gateway/streamRetry.ts", change: "changed" }],
      findings: [
        {
          id: "E-1",
          severity: "high",
          claim: "retry loop can spin",
          role: "reviewer",
          model: "opus-5",
          status: "open",
        },
      ],
      spend: [{ model: "opus-5", input: 1000, output: 200, cost: 0.5 }],
    },
    workspace: {
      branch: "feat/ambient-footer",
      files: [
        { path: "src/panel/PanelComponent.ts", change: "modified", added: 137, removed: 7 },
        { path: "src/日本語/とても長いファイル名.ts", change: "added", added: 12, removed: 0 },
        { path: "assets/logo.png", change: "modified", binary: true },
        { path: `src/${"deeply/".repeat(20)}nested.ts`, change: "deleted", added: 0, removed: 44 },
      ],
      recentCommits: [{ sha: "2efa2d3", subject: "tint the panel 漢字", relative: "14 minutes ago" }],
    },
  });
  return state;
}

console.log("phase 1: the width contract holds against a real theme");
for (const mode of ["truecolor", "256color"] as const) {
  const theme = realTheme(mode);
  let worst = 0;
  let worstAt = 0;
  for (const width of [1, 2, 3, 8, 20, 36, 40, 60, 80, 120, 200]) {
    for (const height of [6, 13, 20, 45]) {
      const component = new PanelComponent({
        state: loadedState(),
        requestRender: () => {},
        fillHeight: () => height,
        theme: theme as never,
        focused: () => false,
        chord: "ctrl+p",
      });
      for (const tab of [0, 1, 2, 3, 4]) {
        for (let i = 0; i < tab; i++) component.handleInput("\t");
        for (const line of component.render(width)) {
          const w = visibleWidth(line);
          if (w > width && w - width > worst - worstAt) {
            worst = w;
            worstAt = width;
          }
        }
      }
      component.dispose();
    }
  }
  check(worst === 0, `${mode}: no line exceeds its width (worst overflow ${worst || 0} vs ${worstAt || "-"})`);
}

console.log("\nphase 2: the panel's background survives the whole row");
{
  const theme = realTheme("truecolor");
  const surface = theme.getBgAnsi("customMessageBg");
  const selected = theme.getBgAnsi("selectedBg");
  const component = new PanelComponent({
    state: loadedState(),
    requestRender: () => {},
    fillHeight: () => 20,
    theme: theme as never,
    focused: () => false,
    chord: "ctrl+p",
  });
  const lines = component.render(46);
  let broken = 0;
  for (const line of lines) {
    // `tint` re-arms after every full reset and closes with one. So every reset
    // except the last must be followed immediately by a background.
    const parts = line.split(RESET);
    for (let i = 1; i < parts.length; i++) {
      const rest = parts[i];
      if (rest.length > 0 && !rest.startsWith(surface) && !rest.startsWith(selected)) broken++;
    }
  }
  check(broken === 0, `every reset re-arms the background (${broken} bare resets)`);
  check(
    lines.every((l) => l.endsWith(RESET)),
    "and every row closes its own colour",
  );
  // The reason it matters, stated as a fact rather than an assumption: it is
  // `truncateToWidth`'s ellipsis that emits a FULL reset, not `theme.fg`, which
  // resets the foreground alone.
  check(theme.fg("dim", "x").endsWith(`${ESC}[39m`), "theme.fg resets the foreground only");
  check(truncateToWidth("abcdefghij", 5, "…").includes(RESET), "truncateToWidth's ellipsis emits a full reset");
  component.dispose();
}

console.log("\nphase 3: nothing writes to the terminal behind the TUI");
{
  const writes: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  };
  const shown: string[] = [];
  const restore = setTelemetrySink((notice) => shown.push(notice.text));
  (process.stdout as { write: unknown }).write = capture;
  (process.stderr as { write: unknown }).write = capture;
  try {
    const component = new PanelComponent({
      state: loadedState(),
      requestRender: () => {},
      fillHeight: () => 20,
      theme: realTheme("truecolor") as never,
    });
    component.render(60);
    component.dispose();
    emitTelemetry(
      describeAdmissionEvent({
        type: "wait",
        waitMs: 30_000,
        signal: {
          retryAfterMs: 30_000,
          retryable: true,
          source: "body",
          status: 429,
          reason: "queue_timeout",
          queued: 31,
          queueLimit: 100,
          activeLimit: 4,
        },
        concurrency: 4,
      }),
      {},
    );
  } finally {
    (process.stdout as { write: unknown }).write = realOut;
    (process.stderr as { write: unknown }).write = realErr;
    restore();
  }
  check(writes.length === 0, `render + telemetry wrote nothing to the terminal (${writes.length} writes)`);
  check(shown.length === 1, "and the diagnostic reached the surface instead");
  check(
    shown[0] === "gateway busy — waiting 30s · queue timeout · 31 of 100 queued · 4 admitted",
    `it reads: ${shown[0]}`,
  );
  if (verbose && writes.length > 0) for (const w of writes) console.log("    leaked:", JSON.stringify(w));
}

console.log("\nphase 4: with no surface the line still reaches stderr");
{
  const writes: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  };
  try {
    emitTelemetry({ level: "warning", text: "gateway busy" }, {});
  } finally {
    (process.stderr as { write: unknown }).write = realErr;
  }
  // A worker, a script and CI have no TUI to corrupt, and stderr is the only
  // record they have. Removing the write would trade a rendering bug for a
  // silent one.
  check(writes.length === 1 && writes[0]!.includes("gateway busy"), "headless diagnostics are not lost");
}

console.log(
  `\n${failures.length === 0 ? "PANEL SURFACE DOGFOOD OK" : `PANEL SURFACE DOGFOOD FAILED (${failures.length})`}`,
);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
