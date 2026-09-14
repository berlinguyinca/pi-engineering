/**
 * Pure, mostly-pure status footer renderer.
 *
 * `renderStatus(state, width, config)` turns the structured `HarnessStatusState`
 * into a single line. It NEVER executes git, network, or expensive token work —
 * the footer reads precomputed state only.
 *
 * Responsive layout: segments have an explicit priority (highest first):
 * throughput, model, branch, worktree, repository, directory. At narrower
 * widths we abbreviate paths then elide segments from the lowest priority,
 * always preserving model + TPS as long as practical. We never allow the line
 * to wrap; the final fallback truncates to the terminal width.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarConfig } from "./config.ts";
import type { HarnessStatusState } from "./state.ts";

const SEP = " │ ";

export interface RenderSegment {
  /** Display text (no ANSI). */
  text: string;
  /** Lower priority drops first. */
  priority: number;
}

/**
 * Render the status line. Returns a plain string (no ANSI); the footer layer
 * applies theme styling. Never throws — on any unexpected input returns "".
 */
export function renderStatus(state: HarnessStatusState, width: number, config: StatusBarConfig): string {
  try {
    return renderUnsafe(state, width, config);
  } catch {
    return "";
  }
}

function renderUnsafe(state: HarnessStatusState, width: number, config: StatusBarConfig): string {
  const maxWidth = Math.max(0, width);

  const throughputFull = formatThroughput(state, true, config);
  const throughputShort = formatThroughput(state, false, config);

  // Build the full and abbreviated segment lists (respecting config toggles).
  const full: RenderSegment[] = [];
  const short: RenderSegment[] = [];

  if (config.showDirectory && state.cwd) {
    full.push({ text: abbreviateHome(state.cwd), priority: 0 });
    short.push({ text: leafOf(state.cwd), priority: 0 });
  }
  if (config.showRepository && state.repository) {
    full.push({ text: state.repository, priority: 1 });
    short.push({ text: shortRepo(state.repository), priority: 1 });
  }
  if (config.showWorktree && state.worktree) {
    full.push({ text: state.worktree, priority: 2 });
    short.push({ text: state.worktree, priority: 2 });
  }
  if (config.showBranch) {
    const ref = formatBranch(state);
    if (ref) {
      full.push({ text: ref, priority: 3 });
      short.push({ text: ref, priority: 3 });
    }
  }
  if (config.showModel && state.model) {
    full.push({ text: formatModel(state), priority: 4 });
    short.push({ text: state.model, priority: 4 });
  }
  if (config.showThroughput && throughputFull) {
    full.push({ text: throughputFull, priority: 5 });
    short.push({ text: throughputShort ?? throughputFull, priority: 5 });
  }

  // Progressive elision: try each stage until it fits.
  const stages: RenderSegment[][] = [];
  stages.push(full);
  stages.push(short);
  // Drop directory, then repository, then worktree, then branch (keep model+tps).
  stages.push(short.filter((s) => s.priority >= 1));
  stages.push(short.filter((s) => s.priority >= 2));
  stages.push(short.filter((s) => s.priority >= 3));
  stages.push(short.filter((s) => s.priority >= 4));

  for (const stage of stages) {
    const line = assemble(stage);
    if (visibleWidth(line) <= maxWidth) return line;
  }

  // Irreducible core (model + tps). Truncate as a last resort so it never wraps.
  const core = assemble(stages[stages.length - 1]!);
  if (visibleWidth(core) <= maxWidth) return core;
  return truncateToWidth(core, maxWidth, "…");
}

function assemble(segments: RenderSegment[]): string {
  return segments
    .filter((s) => s.text.length > 0)
    .map((s) => s.text)
    .join(SEP);
}

function abbreviateHome(path: string): string {
  const home = homeDir();
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) return `~${path.slice(home.length)}`;
  return path;
}

function leafOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

function shortRepo(repo: string): string {
  const parts = repo.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : repo;
}

function formatModel(state: HarnessStatusState): string {
  if (state.provider && state.provider !== state.model) return `${state.provider}/${state.model}`;
  return state.model!;
}

function formatBranch(state: HarnessStatusState): string | null {
  if (state.branch) return state.branch;
  if (state.detachedHead) return `@${state.detachedHead}`;
  return null;
}

function formatThroughput(state: HarnessStatusState, full: boolean, config: StatusBarConfig): string | null {
  const t = state.throughput;
  if (!config.showThroughput) return null;
  const rate =
    t.phase === "streaming"
      ? t.currentTokensPerSecond
      : t.phase === "idle"
        ? t.lastCompletedTokensPerSecond
        : undefined;
  if (t.phase === "waiting") return full ? "⚡ … t/s" : "⚡…";
  if (rate == null) return null; // unavailable / nothing to show
  if (full) return `⚡ ${rate.toFixed(1)} t/s`;
  return `⚡${Math.round(rate)} t/s`;
}

let cachedHome: string | undefined;
function homeDir(): string | undefined {
  if (cachedHome !== undefined) return cachedHome;
  try {
    cachedHome = process.env.HOME || process.env.USERPROFILE || "";
  } catch {
    cachedHome = "";
  }
  return cachedHome || undefined;
}
