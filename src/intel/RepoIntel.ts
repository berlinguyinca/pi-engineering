/**
 * Repository intelligence (spec §26, backlog B-113).
 *
 * Decision: the core does NOT depend on an LSP. Per AGENTS.md ("do not build a
 * custom LSP before evaluating available integrations"), we evaluate external
 * LSP integrations as an optional seam and provide a dependency-free symbol
 * index fallback:
 *
 *   - `symbolIndex(repoRoot)`: a lightweight static scan that maps symbol
 *     names (functions, classes, exported bindings) to file+line via regex over
 *     common JS/TS declaration forms. It powers the `symbol` semantic tool
 *     without an LSP server.
 *
 * An optional `LspIntegration` interface is defined so a real LSP-backed
 * provider (e.g. via vscode-languageserver) can be plugged in without changing
 * core. `None` is the default and only required provider.
 */
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface SymbolLocation {
  symbol: string;
  file: string;
  line: number;
  kind: "function" | "class" | "const" | "export" | "unknown";
}

/** Optional LSP-backed repository-intelligence provider (not required by core). */
export interface LspIntegration {
  readonly name: string;
  symbolAt(repoRoot: string, symbol: string): Promise<SymbolLocation | null>;
}

/** No-op LSP integration: the dependency-free symbol index is used instead. */
export class NoopLspIntegration implements LspIntegration {
  readonly name = "none";
  async symbolAt(): Promise<null> {
    return null;
  }
}

export function isSourceFile(p: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p) && !p.includes("node_modules");
}

const SYMBOL_PATTERNS: Array<{ kind: SymbolLocation["kind"]; re: RegExp }> = [
  { kind: "function", re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
  { kind: "const", re: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]/g },
  { kind: "class", re: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g },
  { kind: "export", re: /export\s+(?:default\s+)?(?:function\s+|class\s+|const\s+)?([A-Za-z_$][\w$]*)/g },
];

/**
 * Build a symbol -> location index for a set of source files. Pure and
 * dependency-free (regex over declarations). Returns a Map symbol -> locations.
 */
const KIND_PRIORITY: Record<SymbolLocation["kind"], number> = {
  function: 0,
  class: 1,
  const: 2,
  export: 3,
  unknown: 4,
};

/**
 * Build a symbol -> location index for a set of source files. Pure and
 * dependency-free (regex over declarations). Deduplicates overlapping matches
 * (e.g. `export function x` matches both the `function` and `export` patterns),
 * keeping the most specific kind. Returns a Map symbol -> locations.
 */
export function buildSymbolIndex(files: Array<{ path: string; content: string }>): Map<string, SymbolLocation[]> {
  const index = new Map<string, SymbolLocation[]>();
  for (const f of files) {
    const lines = f.content.split("\n");
    const seen = new Map<string, SymbolLocation>(); // key: symbol@line
    for (let i = 0; i < lines.length; i++) {
      for (const pat of SYMBOL_PATTERNS) {
        pat.re.lastIndex = 0;
        for (;;) {
          const m = pat.re.exec(lines[i]!);
          if (!m) break;
          const symbol = m[1]!;
          const key = `${symbol}@${i + 1}`;
          const loc: SymbolLocation = { symbol, file: f.path, line: i + 1, kind: pat.kind };
          const existing = seen.get(key);
          if (existing && KIND_PRIORITY[existing.kind] <= KIND_PRIORITY[loc.kind]) continue;
          seen.set(key, loc);
        }
      }
    }
    for (const loc of seen.values()) {
      const arr = index.get(loc.symbol) ?? [];
      arr.push(loc);
      index.set(loc.symbol, arr);
    }
  }
  return index;
}

/** Walk a repo and index symbols in all source files under the given directories. */
export async function symbolIndex(
  repoRoot: string,
  dirs: string[] = ["src", "lib", "."],
): Promise<Map<string, SymbolLocation[]>> {
  const { readdir } = await import("node:fs/promises");
  const files: Array<{ path: string; content: string }> = [];
  async function walk(dir: string, base: string): Promise<void> {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await readdir(join(base, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".pi-eng") continue;
      const full = join(base, dir, e.name);
      const rel = relative(repoRoot, full);
      if (e.isDirectory()) {
        await walk(e.name, join(base, dir));
      } else if (isSourceFile(rel)) {
        const content = await readFile(full, "utf8").catch(() => "");
        files.push({ path: rel, content });
      }
    }
  }
  for (const d of dirs) await walk(d, repoRoot);
  return buildSymbolIndex(files);
}

/** Find all locations for a symbol in an index. */
export function findSymbol(index: Map<string, SymbolLocation[]>, symbol: string): SymbolLocation[] {
  return index.get(symbol) ?? [];
}
