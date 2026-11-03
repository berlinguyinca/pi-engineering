/**
 * B02: pure path policy for bootstrap microtasks. Repo-relative; deny beats allow; no implicit **.
 * Normalization delegates to the existing write-domain canonicalizer so the two cannot drift.
 */
import { canonicalizeWriteDomain } from "../orchestration/workset.ts";

export interface PathPolicyInput {
  readonly allowPaths: readonly string[];
  readonly denyPaths?: readonly string[];
  /** Paths the caller observed (e.g. by lstat) to be symlinks; never traversed. */
  readonly symlinks?: readonly string[];
}
export interface PathDecision { readonly allowed: boolean; readonly path: string; readonly reason: string }
type Pattern = { readonly source: string; readonly any: boolean; readonly prefix: string[] | null; readonly exact: string | null };

const AMBIGUOUS = /[*?"<>|\\]/u;

function compile(pattern: string): Pattern {
  const canonical = canonicalizeWriteDomain(pattern);
  if (canonical === "**") return { source: pattern, any: true, prefix: null, exact: null };
  if (canonical.endsWith("/**")) return { source: pattern, any: false, prefix: canonical.slice(0, -3).split("/"), exact: null };
  return { source: pattern, any: false, prefix: null, exact: canonical };
}

function matches(pattern: Pattern, segments: string[]): boolean {
  if (pattern.prefix) return segments.length >= pattern.prefix.length && pattern.prefix.every((s, i) => segments[i] === s);
  return pattern.any || segments.join("/") === pattern.exact;
}

export function createPathPolicy(input: PathPolicyInput): { policy: { check(request: string): PathDecision } | null; errors: string[] } {
  const compileAll = (patterns: readonly string[], kind: string): [Pattern[], string[]] => {
    const compiled: Pattern[] = []; const errors: string[] = [];
    for (const pattern of patterns) {
      try { compiled.push(compile(pattern)); } catch (error) { errors.push(`${kind} pattern "${pattern}" is not canonical: ${(error as Error).message}`); }
    }
    return [compiled, errors];
  };
  const [allow, allowErrors] = compileAll(input.allowPaths, "allow");
  const [deny, denyErrors] = compileAll(input.denyPaths ?? [], "deny");
  const errors = [...allowErrors, ...denyErrors]; if (errors.length > 0) return { policy: null, errors };
  const anchors = new Set((input.symlinks ?? []).map((path) => canonicalizeWriteDomain(path)));
  return {
    errors,
    policy: {
      check(request: string): PathDecision {
        const reject = (reason: string): PathDecision => ({ allowed: false, path: request, reason });
        if (AMBIGUOUS.test(request)) return reject("ambiguous path: glob metacharacters and backslashes are not accepted");
        if (request.startsWith("~")) return reject("home-relative paths are rejected");
        if (request.endsWith("/")) return reject("ambiguous path: trailing separator");
        if (request.trim() === "" || request !== request.trim()) return reject("ambiguous path: blank or whitespace-padded");
        let path: string;
        try { path = canonicalizeWriteDomain(request); } catch (error) { return reject((error as Error).message); }
        const segments = path.split("/");
        for (let depth = 1; depth <= segments.length; depth += 1) {
          const ancestor = segments.slice(0, depth).join("/");
          if (anchors.has(ancestor)) return reject(`path traverses symlink "${ancestor}"`);
        }
        const denied = deny.find((pattern) => matches(pattern, segments));
        if (denied) return reject(`denied by "${denied.source}"`);
        const granted = allow.find((pattern) => matches(pattern, segments));
        return granted ? { allowed: true, path, reason: `matched by "${granted.source}"` } : reject("no allow pattern matches");
      },
    },
  };
}
