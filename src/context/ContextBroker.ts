import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { GitRepo } from "../git/GitRepo.ts";

const exec = promisify(execFile);

/** A single retrievable context item with relevance metadata (spec §10.5). */
export interface ContextItem {
  id: string;
  kind: "file" | "symbol" | "test" | "history" | "ledger";
  path: string;
  summary: string;
  estimatedTokens: number;
  required: boolean;
  /** True when a required file's slice was truncated to fit the remaining budget. */
  truncated?: boolean;
}

/** A bounded context package assembled for a task (spec §10, §17.2). */
export interface ContextPackage {
  id: string;
  goal: string;
  targetTokens: number;
  items: ContextItem[];
  totalTokens: number;
  sources: string[];
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

const DEFAULT_IGNORES = [".git", "node_modules", "dist", "build", "out", ".pi-eng"];

/** Escape regex metacharacters so goal keywords are searched as literals. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derive searchable keywords from a goal by extracting alphanumeric runs
 * (stripping punctuation). 'Implement add(a, b) to return a + b' yields
 * ['Implement', 'add', 'to', 'return'] — NOT the broken token 'add(a,' that a
 * whitespace split produces. Bounded and de-duplicated.
 */
function isTestPath(p: string): boolean {
  return /(^|\/)test\//i.test(p) || /\.test\.|_test\./i.test(p) || /\/tests\//i.test(p);
}

function goalKeywords(goal: string, limit = 6): string[] {
  const matches = goal.match(/[A-Za-z][A-Za-z0-9_]{1,}/g) ?? [];
  return [...new Set(matches)].slice(0, limit);
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Lightweight Context Broker (spec §10).
 *
 * The vertical-slice implementation retrieves repository context incrementally
 * (file listing, symbol search, slice reads, test discovery) rather than dumping
 * the whole repository into a prompt. It returns bounded context packages.
 */
export class ContextBroker {
  private readonly repo: GitRepo;
  private readonly repoRoot: string;

  private constructor(repo: GitRepo) {
    this.repo = repo;
    this.repoRoot = repo.root;
  }

  static async open(cwd: string): Promise<ContextBroker | null> {
    const repo = await GitRepo.open(cwd);
    if (!repo) return null;
    return new ContextBroker(repo);
  }

  /** Compact repository map (paths + a one-line guess of kind). */
  async repoMap(limit = 200): Promise<string[]> {
    const r = await exec("git", ["-C", this.repoRoot, "ls-files"], { maxBuffer: 64 * 1024 * 1024 });
    const files = r.stdout
      .split("\n")
      // Match ignore tokens against whole path SEGMENTS, not substrings, so a
      // real file like "distribution.ts" is not dropped merely because its
      // name contains "dist".
      .filter((f) => f.trim() && !DEFAULT_IGNORES.some((ig) => f.split("/").some((seg) => seg === ig)))
      .slice(0, limit);
    return files;
  }

  /** Run a git grep over the repo with an already-built ERE pattern. */
  private async grep(pattern: string, limit: number): Promise<SearchHit[]> {
    if (!pattern.trim()) return []; // an empty pattern would match every line
    let out = "";
    try {
      const r = await exec(
        "git",
        ["-C", this.repoRoot, "grep", "-n", "-E", "--no-color", "-I", "-e", pattern, "--", "."],
        { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
      );
      out = r.stdout;
    } catch (err) {
      // git grep exits 1 when there are no matches (normal -> empty). Any other
      // non-zero exit is a real grep/pattern error and must NOT be silently
      // swallowed as "no matches", which would yield an empty context package
      // for a valid goal containing regex metacharacters.
      const e = err as { code?: number };
      if (e.code === 1) return [];
      throw new Error(`git grep failed for pattern ${JSON.stringify(pattern)}: ${String(err)}`);
    }
    const hits: SearchHit[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const idx = line.indexOf(":");
      const idx2 = idx >= 0 ? line.indexOf(":", idx + 1) : -1;
      if (idx < 0 || idx2 < 0) continue;
      const path = line.slice(0, idx);
      const lineNo = Number.parseInt(line.slice(idx + 1, idx2), 10);
      hits.push({ path, line: Number.isNaN(lineNo) ? 0 : lineNo, text: line.slice(idx2 + 1).trim() });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Literal symbol/text search over the repo (single query, regex-safe). */
  async search(query: string, limit = 40): Promise<SearchHit[]> {
    return this.grep(escapeRegex(query), limit);
  }

  /**
   * Search for ANY of several literal keywords, building a safe alternation by
   * escaping each keyword individually (so 'a|b' matches files containing a
   * OR b — never the literal text 'a|b').
   */
  async searchAny(keywords: string[], limit = 40): Promise<SearchHit[]> {
    const kws = keywords.map((k) => k.trim()).filter(Boolean);
    if (kws.length === 0) return [];
    return this.grep(kws.map(escapeRegex).join("|"), limit);
  }

  /**
   * Read a bounded slice of a file (lazy, incremental retrieval).
   * The path is resolved against the repo root and confined to it, so a
   * worker-supplied path cannot escape the repository (path-traversal safety).
   */
  async readSlice(filePath: string, offset = 0, limit = 100): Promise<string | null> {
    const abs = resolve(join(this.repoRoot, filePath));
    if (!abs.startsWith(resolve(this.repoRoot) + sep)) return null;
    try {
      const content = await readFile(abs, "utf-8");
      const lines = content.split("\n");
      return lines.slice(offset, offset + limit).join("\n");
    } catch {
      return null;
    }
  }

  /** Discover test files relevant to given symbols (name/ref matching). */
  async testsFor(symbols: string[], limit = 20): Promise<string[]> {
    const hits = await this.searchAny(symbols, limit);
    const testFiles = new Set<string>();
    for (const h of hits) {
      if (/test|spec|__tests__/i.test(h.path)) testFiles.add(h.path);
      if (testFiles.size >= limit) break;
    }
    return [...testFiles];
  }

  /**
   * Rank repository files by relevance to the goal keywords: path substring
   * matches (cheap, no content read) plus symbol-hit counts from git grep.
   * Returns the top `limit` file paths, most-relevant first. This lets the
   * context assembler pull in the *content* of the most relevant files up front
   * (instead of only one-line symbol hits), so a worker does fewer tool
   * round-trips to locate what it needs.
   */
  async rankFiles(keywords: string[], limit = 10): Promise<string[]> {
    const paths = await this.repoMap(500);
    const score = new Map<string, number>();
    for (const p of paths) {
      const lower = p.toLowerCase();
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score.set(p, (score.get(p) ?? 0) + 3);
      }
    }
    // Symbol hits: a file containing several DISTINCT goal keywords is more
    // relevant than one with many incidental matches of a single keyword
    // (raw line frequency would over-weight a test file that repeats a symbol).
    const lowerKw = keywords.map((k) => k.toLowerCase());
    const hits = await this.searchAny(keywords, 200);
    const byPath = new Map<string, Set<string>>();
    for (const h of hits) {
      const text = h.text.toLowerCase();
      const matched = lowerKw.filter((kw) => text.includes(kw));
      if (matched.length === 0) continue;
      if (!byPath.has(h.path)) byPath.set(h.path, new Set());
      for (const kw of matched) byPath.get(h.path)!.add(kw);
    }
    for (const [path, matchedKws] of byPath) {
      score.set(path, (score.get(path) ?? 0) + Math.min(matchedKws.size, 5));
    }
    return [...score.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        // Tie-break: prefer non-test source files, then shorter paths, so
        // ranking is deterministic and not an artifact of ls-files order.
        const at = isTestPath(a[0]);
        const bt = isTestPath(b[0]);
        if (at !== bt) return at ? 1 : -1;
        return a[0].length - b[0].length;
      })
      .slice(0, limit)
      .map(([p]) => p);
  }

  /** Assemble a bounded context package for a task, filling the token budget in priority order. */
  async assembleContext(goal: string, targetTokens: number, required: string[]): Promise<ContextPackage> {
    const items: ContextItem[] = [];
    let total = 0;

    const push = (item: ContextItem): boolean => {
      if (total + item.estimatedTokens > targetTokens) return false;
      total += item.estimatedTokens;
      items.push(item);
      return true;
    };

    // Required files first. If a required file's slice would exceed the
    // remaining budget it is TRUNCATED (not silently dropped) so the
    // "required context" guarantee holds even for large files.
    for (const rel of required) {
      const text = await this.readSlice(rel, 0, 300);
      if (text === null) continue;
      const remaining = targetTokens - total;
      const est = estimateTokens(text);
      if (est > remaining && remaining > 0) {
        const slice = text.slice(0, Math.max(0, Math.floor(remaining * 4)));
        push({
          id: `file:${rel}`,
          kind: "file",
          path: rel,
          summary: slice,
          estimatedTokens: estimateTokens(slice),
          required: true,
          truncated: true,
        });
      } else {
        push({
          id: `file:${rel}`,
          kind: "file",
          path: rel,
          summary: text,
          estimatedTokens: est,
          required: true,
        });
      }
    }

    const keywords = goalKeywords(goal);
    const seen = new Set(items.map((i) => i.id));

    // Relevance-ranked file content: include the most relevant files' content
    // slices (bounded by the token budget) so a worker has the actual code it
    // needs up front, rather than re-fetching it with extra tool round-trips.
    for (const rel of await this.rankFiles(keywords, 8)) {
      if (seen.has(`file:${rel}`)) continue;
      seen.add(`file:${rel}`);
      const text = await this.readSlice(rel, 0, 60);
      if (text === null) continue;
      push({
        id: `file:${rel}`,
        kind: "file",
        path: rel,
        summary: text,
        estimatedTokens: estimateTokens(text),
        required: false,
      });
    }

    // Symbol one-liners from the goal keywords (fill remaining budget).
    const hits = await this.searchAny(keywords, 20);
    for (const hit of hits) {
      if (seen.has(`symbol:${hit.path}`)) continue;
      seen.add(`symbol:${hit.path}`);
      push({
        id: `symbol:${hit.path}`,
        kind: "symbol",
        path: hit.path,
        summary: `${hit.path}:${hit.line} — ${hit.text.slice(0, 120)}`,
        estimatedTokens: estimateTokens(hit.text.slice(0, 120)),
        required: false,
      });
      if (items.length >= 30) break;
    }

    return {
      id: `CTX-${Math.random().toString(36).slice(2, 8)}`,
      goal,
      targetTokens,
      items,
      totalTokens: total,
      sources: ["git grep", "file reads", "git ls-files"],
    };
  }

  /** Render a context package to the compact text a worker receives. */
  renderContext(pkg: ContextPackage): string {
    const lines: string[] = [];
    lines.push(`# Task context (${pkg.totalTokens} tokens, budget ${pkg.targetTokens})`);
    for (const item of pkg.items) {
      lines.push(`\n## ${item.kind}: ${item.path}`);
      lines.push(item.summary);
    }
    return lines.join("\n");
  }
}
