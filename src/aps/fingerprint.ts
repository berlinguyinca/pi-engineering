/**
 * APS Phase 1 — normalization and semantic fingerprinting.
 *
 * The goal is a fingerprint that is:
 *  - IDENTICAL for the same intent + target + no state change, even when the
 *    raw invocation differs cosmetically (timestamps, absolute path prefixes,
 *    whitespace, argument key order, formatting-only churn), and
 *  - DIFFERENT when the inputs really change (different target, different
 *    payload, different tool intent) or when the observed state changes
 *    (the tool result summary differs, e.g. a file changed between reads).
 *
 * `ToolCallNormalizer` maps a raw tool call to a canonical strategy family
 * plus a normalized target. `semanticFingerprint` hashes the canonical
 * material (family, target, normalized arguments, normalized result summary)
 * with FNV-1a 64 — pure, deterministic, dependency-free.
 */

import type { NormalizedToolCall, SemanticStrategyFamily } from "./types.ts";

/** A raw tool invocation, before normalization. */
export interface RawToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Argument keys whose values are volatile per invocation (timestamps and the
 * like) and must never influence a fingerprint.
 */
export const VOLATILE_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  "timestamp",
  "time",
  "datetime",
  "date",
  "ts",
  "epoch",
  "now",
  "startedAt",
  "endedAt",
  "createdAt",
  "updatedAt",
  "modifiedAt",
  "occurredAt",
  "since",
  "until",
]);

/** Argument keys whose string values are file paths (get path canonicalization). */
const PATH_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  "path",
  "file",
  "file_path",
  "file_name",
  "filename",
  "uri",
  "url",
  "dir",
  "directory",
]);

/** Argument keys, in priority order, from which the canonical target is taken. */
const TARGET_ARGUMENT_KEYS: readonly string[] = [
  "path",
  "file_path",
  "file",
  "file_name",
  "filename",
  "uri",
  "url",
  "dir",
  "directory",
  "symbol",
  "symbols",
  "query",
  "pattern",
  "question",
  "command",
  "cmd",
  "ref",
  "work_item_id",
];

const CONFIG_FILE_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "biome.json",
  ".env",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".editorconfig",
]);

/**
 * Canonicalize a path-like string:
 *  - backslashes to forward slashes,
 *  - surrounding/inner whitespace collapsed,
 *  - a known absolute `rootPrefix` stripped (session cwd),
 *  - `~` home prefixes and absolute leading slashes stripped,
 *  - duplicate slashes and trailing slashes collapsed.
 * Scheme URIs (e.g. `artifact://...`) are trimmed but otherwise untouched.
 */
export function normalizePathLike(value: string, rootPrefix?: string): string {
  let s = value.replace(/\\/g, "/").replace(/\s+/g, " ").trim();
  if (rootPrefix !== undefined && rootPrefix !== "") {
    const prefix = rootPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
    if (prefix !== "") {
      if (s === prefix) return ".";
      if (s.startsWith(`${prefix}/`)) s = s.slice(prefix.length + 1);
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s; // scheme URI: keep as-is
  s = s.replace(/^~\//, "");
  const segments: string[] = [];
  for (const rawPart of s.split("/")) {
    const part = rawPart.trim();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

/**
 * Deep canonical form: sorted object keys, dropped `undefined`, whitespace
 * collapsed in strings, arrays mapped. Pure and deterministic.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = canonicalize(src[key]);
    }
    return out;
  }
  return value;
}

/** Stable JSON: canonical form, then stringified (key order is canonical). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const FNV_OFFSET64 = 0xcbf29ce484222325n;
const FNV_PRIME64 = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit as a 16-char hex string. Pure, deterministic, no deps. */
export function fnv1a64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let h = FNV_OFFSET64;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME64) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

function isTestPath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return /(^|\/)tests?\//.test(path) || /(^test-|\.test\.|\.spec\.|-test\.|-spec\.)/.test(base);
}

function isConfigPath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (CONFIG_FILE_BASENAMES.has(base)) return true;
  if (base.startsWith("tsconfig.") && base.endsWith(".json")) return true;
  return /\.(toml|ini|cfg|conf|ya?ml)$/.test(base);
}

export interface ToolCallNormalizerOptions {
  /** Absolute prefix stripped from path arguments (e.g. the session cwd). */
  rootPrefix?: string;
  /** Explicit tool-name -> family overrides (matched case-insensitively). */
  toolFamilyMap?: Record<string, SemanticStrategyFamily>;
}

/** True when `token` occurs as its own segment of a tool name (e.g. "cat" in "read_cat", not "frobnicate"). */
function hasToken(name: string, token: string): boolean {
  return new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(name);
}

/** Maps raw tool calls to a canonical strategy family + normalized target. */
export class ToolCallNormalizer {
  private readonly rootPrefix: string | undefined;
  private readonly toolFamilyMap: Map<string, SemanticStrategyFamily>;

  constructor(options: ToolCallNormalizerOptions = {}) {
    this.rootPrefix = options.rootPrefix;
    this.toolFamilyMap = new Map(Object.entries(options.toolFamilyMap ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  }

  /**
   * Normalize a raw arguments object: drop volatile (timestamp) keys,
   * collapse whitespace in strings, canonicalize paths for path-like keys,
   * sort keys. Idempotent.
   */
  normalizeArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(arguments_).sort()) {
      if (VOLATILE_ARGUMENT_KEYS.has(key)) continue;
      const raw = arguments_[key];
      if (raw === undefined) continue;
      out[key] = this.normalizeValue(raw, PATH_ARGUMENT_KEYS.has(key));
    }
    return out;
  }

  private normalizeValue(value: unknown, isPath: boolean): unknown {
    if (Array.isArray(value)) return value.map((v) => this.normalizeValue(v, isPath));
    if (typeof value === "string") {
      const s = value.replace(/\s+/g, " ").trim();
      return isPath ? normalizePathLike(s, this.rootPrefix) : s;
    }
    if (value !== null && typeof value === "object") {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) out[key] = this.normalizeValue(src[key], false);
      return out;
    }
    return value;
  }

  /** Map a tool name to its canonical strategy family (without target refinement). */
  familyFor(toolName: string): SemanticStrategyFamily {
    const name = toolName.toLowerCase();
    const mapped = this.toolFamilyMap.get(name);
    if (mapped) return mapped;
    if (name.includes("artifact")) return "INSPECT_ARTIFACT";
    if (hasToken(name, "ask") || name.includes("question") || name.includes("confirm")) return "ASK_USER";
    if (name.includes("plan")) return "UPDATE_PLAN";
    if (name.includes("search") || name.includes("grep") || name.includes("find")) {
      if (name.includes("symbol") || name.includes("lsp")) return "SEARCH_SYMBOL";
      if (name.includes("file")) return "SEARCH_FILE";
      return "SEARCH_TEXT";
    }
    if (/(^|_)tests?_for/.test(name)) return "SEARCH_FILE";
    if (name.includes("test")) return "RUN_TEST";
    if (name.includes("build")) return "RUN_BUILD";
    if (name.includes("typecheck") || name === "tsc") return "RUN_TYPECHECK";
    if (name.includes("format") || name.includes("prettier") || name.includes("biome") || name.includes("lint"))
      return "RUN_FORMAT";
    if (/(^|_)(edit|write|create|patch|apply|update|modify|replace|delete|remove|rename)(_|$)/.test(name))
      return "EDIT_FILE";
    if (
      name.includes("run") ||
      name.includes("exec") ||
      name.includes("shell") ||
      name.includes("bash") ||
      name.includes("command") ||
      name.includes("spawn")
    )
      return "RUN_COMMAND";
    if (
      name === "ls" ||
      name.includes("list") ||
      name.includes("read") ||
      hasToken(name, "cat") ||
      name.includes("open") ||
      hasToken(name, "view") ||
      name.includes("show") ||
      name.includes("inspect") ||
      name.includes("head") ||
      name.includes("tail") ||
      name.includes("symbol")
    ) {
      return name.includes("dir") || name === "ls" || name.includes("list") ? "READ_DIRECTORY" : "READ_FILE";
    }
    if (
      name.includes("generate") ||
      hasToken(name, "text") ||
      name.includes("chat") ||
      name.includes("respond") ||
      name.includes("answer")
    )
      return "GENERATE_TEXT";
    return "CALL_TOOL";
  }

  /** Full normalization: family, canonical target, cleaned arguments. */
  normalize(call: RawToolCall): NormalizedToolCall {
    const normalized = this.normalizeArguments(call.arguments ?? {});
    let family = this.familyFor(call.name);
    let target = this.extractTarget(normalized);
    if (family === "EDIT_FILE" && target !== "") {
      if (isTestPath(target)) family = "MODIFY_TEST";
      else if (isConfigPath(target)) family = "MODIFY_CONFIG";
    }
    if (family === "CALL_TOOL" && target === "") target = call.name.toLowerCase();
    return { family, target, arguments: normalized };
  }

  private extractTarget(normalized: Record<string, unknown>): string {
    for (const key of TARGET_ARGUMENT_KEYS) {
      const value = normalized[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        const parts = value.map((v) => (typeof v === "string" ? v : canonicalJson(v))).filter((p) => p.length > 0);
        if (parts.length > 0) return parts.join(",");
        continue;
      }
      if (typeof value === "string") {
        if (value.length > 0) return value;
        continue;
      }
      if (typeof value === "number" || typeof value === "boolean") return String(value);
    }
    return "";
  }
}

let sharedNormalizer: ToolCallNormalizer | undefined;
function defaultNormalizer(): ToolCallNormalizer {
  sharedNormalizer ??= new ToolCallNormalizer();
  return sharedNormalizer;
}

/** The fields `semanticFingerprint` needs; `AgentAction` satisfies this structurally. */
export interface FingerprintInput {
  tool: string;
  normalizedArguments: Record<string, unknown>;
  toolResultSummary: string;
}

/**
 * Stable semantic fingerprint of an action.
 *
 * Identical for the same intent (family) + target + arguments + result
 * summary, regardless of cosmetic churn (the input is re-normalized, which is
 * idempotent). Changes when the inputs change or when the result summary
 * changes — the latter is how "state changed" is observed (e.g. a file
 * modified between two reads).
 */
export function semanticFingerprint(
  input: FingerprintInput,
  normalizer: ToolCallNormalizer = defaultNormalizer(),
): string {
  const call = normalizer.normalize({ name: input.tool, arguments: input.normalizedArguments });
  const material = canonicalJson({
    family: call.family,
    target: call.target,
    arguments: input.normalizedArguments,
    result: input.toolResultSummary.replace(/\s+/g, " ").trim(),
  });
  return fnv1a64(material);
}
