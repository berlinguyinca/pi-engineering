import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
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
      .filter((f) => f.trim() && !DEFAULT_IGNORES.some((ig) => f.includes(ig)))
      .slice(0, limit);
    return files;
  }

  /** Symbol/text search over the repo (git grep; bounded output). */
  async search(query: string, limit = 40): Promise<SearchHit[]> {
    let out = "";
    try {
      const r = await exec(
        "git",
        ["-C", this.repoRoot, "grep", "-n", "-E", "--no-color", "-I", "-e", escapeRegex(query), "--", "."],
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
      throw new Error(`git grep failed for query ${JSON.stringify(query)}: ${String(err)}`);
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
    const hits = await this.search(symbols.join("|"), limit);
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
    const hits = await this.search(keywords.join("|"), 200);
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
      .sort((a, b) => b[1] - a[1])
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

    // Required files first.
    for (const rel of required) {
      const text = await this.readSlice(rel, 0, 300);
      if (text !== null) {
        push({
          id: `file:${rel}`,
          kind: "file",
          path: rel,
          summary: text,
          estimatedTokens: estimateTokens(text),
          required: true,
        });
      }
    }

    const keywords = goal.split(/\s+/).filter((w) => w.length >= 3).slice(0, 6);
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
    const hits = await this.search(keywords.join("|"), 20);
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
