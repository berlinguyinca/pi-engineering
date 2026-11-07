/**
 * B03: diff-scope and size guard for bootstrap microtasks. Pure and read-only — it consumes
 * `git status --porcelain` / `git diff --numstat` metadata, never runs git and never touches the
 * tree. Path grants come from the B02 policy, so scope semantics cannot drift between the two.
 * Scope is the union of working-tree paths and committed paths: the handoff gate stamps a *clean*
 * worktree, so porcelain alone would make every path grant and file budget vacuous.
 */
import { createPathPolicy } from "./pathPolicy.ts";
import type { TaskManifest } from "./taskManifest.ts";

export interface DiffMetadata { readonly porcelain: string; readonly numstat: string }
export type DiffViolationKind = "unexpected-path" | "denied-path" | "generated-file" | "binary-change" | "read-only-mode" | "production-file-budget" | "test-file-budget" | "changed-line-budget";
export interface DiffViolation { kind: DiffViolationKind; path: string | null; detail: string }
export interface DiffGuardReport { ok: boolean; changedPaths: string[]; productionFiles: number; testFiles: number; added: number; deleted: number; violations: DiffViolation[] }
type DiffRow = { path: string; added: number; removed: number; binary: boolean };

const GENERATED_DIR = /(^|\/)(dist|build|coverage|generated|node_modules)\//u;
const GENERATED_FILE = /\.(min\.[cm][jt]s|map|snap|lock)$/u;
const isTestPath = (path: string): boolean => path.startsWith("test/") || /\.test\.[cm]?[jt]sx?$/u.test(path);

function porcelainPaths(porcelain: string): string[] {
  const paths = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "" || line.startsWith("!!")) continue; // blank / ignored by git
    const body = line.slice(3); // "XY <path>" or "XY <old> -> <new>"
    for (const part of body.includes(" -> ") ? body.split(" -> ") : [body]) {
      const path = part.replace(/^"/gu, "").replace(/"$/gu, "");
      if (path !== "") paths.add(path);
    }
  }
  return [...paths].sort();
}

function numstatRows(numstat: string): { rows: DiffRow[]; added: number; deleted: number } {
  const rows: DiffRow[] = []; let added = 0; let deleted = 0;
  for (const line of numstat.split("\n")) {
    if (line.trim() === "") continue;
    const [first, second, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (path === "") continue;
    const binary = first === "-" || second === "-";
    const row: DiffRow = { path, added: binary ? 0 : Number.parseInt(first ?? "0", 10) || 0, removed: binary ? 0 : Number.parseInt(second ?? "0", 10) || 0, binary };
    rows.push(row); added += row.added; deleted += row.removed;
  }
  return { rows, added, deleted };
}

export function evaluateDiffScope(manifest: TaskManifest, meta: DiffMetadata, symlinks: readonly string[] = []): DiffGuardReport {
  const { rows, added, deleted } = numstatRows(meta.numstat);
  // Committed paths must join the scope set: at the stamping commit the tree is clean, so porcelain
  // is empty while numstat still names every file the task actually changed.
  const changedPaths = [...new Set([...porcelainPaths(meta.porcelain), ...rows.map((row) => row.path)])].sort();
  const built = createPathPolicy({ allowPaths: manifest.allowPaths, denyPaths: manifest.denyPaths, symlinks });
  const violations: DiffViolation[] = [];
  const push = (kind: DiffViolationKind, path: string | null, detail: string): void => { violations.push({ kind, path, detail }); };
  for (const path of changedPaths) {
    const decision = built.policy?.check(path) ?? { allowed: false, path, reason: "path policy unavailable: " + built.errors.join("; ") };
    if (!decision.allowed) push(decision.reason.startsWith("denied by") ? "denied-path" : "unexpected-path", path, decision.reason);
    if (GENERATED_DIR.test(path) || GENERATED_FILE.test(path)) push("generated-file", path, "machine-generated output is never an accepted deliverable");
  }
  for (const row of rows) if (row.binary) push("binary-change", row.path, "git numstat reported a binary change (-)");
  if (manifest.mode === "read-only" && changedPaths.length > 0) push("read-only-mode", null, `${changedPaths.length} changed path(s) under a read-only manifest`);
  const productionFiles = changedPaths.filter((path) => !isTestPath(path)).length;
  const testFiles = changedPaths.length - productionFiles;
  const { maxProductionFiles, maxTestFiles, maxChangedLines } = manifest.limits;
  if (productionFiles > maxProductionFiles) push("production-file-budget", null, `${productionFiles} production file(s) > limit ${maxProductionFiles}`);
  if (testFiles > maxTestFiles) push("test-file-budget", null, `${testFiles} test file(s) > limit ${maxTestFiles}`);
  if (added + deleted > maxChangedLines) push("changed-line-budget", null, `${added} added + ${deleted} deleted > limit ${maxChangedLines}`);
  return { ok: violations.length === 0, changedPaths, productionFiles, testFiles, added, deleted, violations: violations.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.path).localeCompare(String(b.path)) || a.detail.localeCompare(b.detail)) };
}
