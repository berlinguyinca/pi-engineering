import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { GitRepo } from "../git/GitRepo.ts";
import { safeGitOrThrow } from "../git/safeGit.ts";

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

function isTestPath(p: string): boolean {
  return /(^|\/)test\//i.test(p) || /\.test\.|_test\./i.test(p) || /\/tests\//i.test(p);
}

/** Frozen English stopwords: prose glue that must never become a search keyword. */
const STOPWORD_LIST =
  "the a an and or but to of for in on at by with from into is are was were be been this that these those it " +
  "its as if then than so such not no nor do does did can will would should could may might must shall we you " +
  "they he she i our your their my his her them us please make use using via when while where what which who " +
  "how why all any each every some none more most other onto over under again once about against between " +
  "during before after above below up down out off too very just also there here add adds adding return " +
  "returns fix fixes fixing";
const STOPWORDS: ReadonlySet<string> = new Set(STOPWORD_LIST.split(" "));

/**
 * Weight a goal token: path-like ('/' or '.ext'), identifier-shaped (`snake_case`, camel hump, ALL-CAPS) and
 * `name(` call sites name code; a mid-sentence capital is a proper noun. Those outrank plain prose, with small
 * bonuses for a repeat and the back half of the goal, so a distinctive tail beats the generic head.
 */
function tokenWeight(token: string, index: number, total: number, repeats: number, callSite: boolean): number {
  const codeLike = callSite || token.includes("/") || /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(token);
  const ident = token.includes("_") || /[a-z][A-Z]/.test(token) || /^[A-Z][A-Z0-9]+$/.test(token);
  const bonus = Math.min(repeats - 1, 2) + (index >= (total - 1) / 2 ? 0.5 : 0);
  return 1 + (codeLike ? 3 : 0) + (ident ? 2 : 0) + (index > 0 && /^[A-Z]/.test(token) ? 2 : 0) + bonus;
}

/**
 * Searchable keywords for a goal: alphanumeric runs joined across '/' and '.' ('src/add.js' stays ONE token,
 * while 'add(a, b)' yields 'add' and never the broken 'add(a,') minus the frozen English stopwords, so prose
 * glue like 'to'/'return' never becomes a search term — except a stopword written as a call site is code, so
 * 'add' survives. Ordered by `tokenWeight` (ties by first appearance), de-duplicated, capped at `limit`
 * (default 6); an all-stopword goal keeps its first raw token rather than returning [].
 */
export function goalKeywords(goal: string, limit = 6): string[] {
  const raw = goal.match(/[A-Za-z][A-Za-z0-9_]*(?:[/.][A-Za-z][A-Za-z0-9_]+)+|[A-Za-z][A-Za-z0-9_]+/g) ?? [];
  const calls = new Set((goal.match(/[A-Za-z][A-Za-z0-9_]*(?=\s*\()/g) ?? []).map((t) => t.toLowerCase()));
  const kept: [string, number, number][] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const lower = raw[index]!.toLowerCase();
    const callSite = calls.has(lower); // `name(` is code, not the prose verb
    if (seen.has(lower) || (!callSite && STOPWORDS.has(lower))) continue;
    seen.add(lower);
    const repeats = raw.filter((t) => t.toLowerCase() === lower).length; // goals are short
    kept.push([raw[index]!, tokenWeight(raw[index]!, index, raw.length, repeats, callSite), index]);
  }
  if (kept.length === 0) return raw.slice(0, 1); // all prose: never an empty keyword list
  kept.sort((a, b) => b[1] - a[1] || a[2] - b[2]);
  return kept.slice(0, limit).map((k) => k[0]);
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
    const r = await safeGitOrThrow(["ls-files"], {
      cwd: this.repoRoot,
      trust: "operator",
      maxBuffer: 64 * 1024 * 1024,
    });
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
      const r = await safeGitOrThrow(["grep", "-n", "-E", "--no-color", "-I", "-e", pattern, "--", "."], {
        cwd: this.repoRoot,
        trust: "operator",
        maxBuffer: 4 * 1024 * 1024,
        timeoutMs: 30_000,
      });
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
   * matches (cheap, no content read) weighted by each keyword's `tokenWeight`,
   * plus distinct keyword hits from git grep. Top `limit` (default 10). This lets the
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
        if (lower.includes(kw.toLowerCase())) score.set(p, (score.get(p) ?? 0) + 3 * tokenWeight(kw, 0, 1, 1, false));
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
        // Tie-break: non-test source files, then shorter paths, then the path, so
        // ranking is deterministic and not an artifact of ls-files order.
        const at = isTestPath(a[0]);
        const bt = isTestPath(b[0]);
        if (at !== bt) return at ? 1 : -1;
        return a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
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
