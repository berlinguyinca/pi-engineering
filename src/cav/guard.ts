/**
 * CAV protected-artifact guard (PROTECTED_ARTIFACTS contract).
 *
 * Acceptance contracts, sabotage fixtures, golden references and completion
 * policy are protected artifacts. A normal implementer run may read them but
 * may not silently mutate them. This guard fails closed: a change touching a
 * protected path by a non-authorized role is rejected before any CAV gate can
 * pass, so an implementation can never "fix" a failing verification by
 * weakening its acceptance criteria.
 */
import { DEFAULT_PROTECTED_PATHS } from "./types.ts";

/** Thrown when a protected artifact would be silently modified. */
export class CavGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CavGateError";
  }
}

/** Convert a glob-ish path prefix (double-star glob) into a RegExp. */
const REGEX_META = new Set([".", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
const DOUBLE_STAR = "__CAV_DOUBLE_STAR__";

function globToRegExp(glob: string): RegExp {
  // Escape all regex metacharacters except '*' which is handled below.
  let escaped = "";
  for (const ch of glob) escaped += REGEX_META.has(ch) ? `\\${ch}` : ch;
  // Replace ** before * so double-star expands to a directory-spanning match.
  const wildcards = escaped.replace(/\*\*/g, DOUBLE_STAR).replace(/\*/g, "[^/]*").replaceAll(DOUBLE_STAR, ".*");
  return new RegExp(`^${wildcards}$`);
}

export class ProtectedArtifactGuard {
  private readonly patterns: RegExp[];

  constructor(protectedPaths: string[] = DEFAULT_PROTECTED_PATHS) {
    this.patterns = protectedPaths.map(globToRegExp);
  }

  /** True if the given relative path matches a protected path. */
  isProtected(relativePath: string): boolean {
    const norm = relativePath.replace(/^\.\//, "");
    return this.patterns.some((re) => re.test(norm));
  }

  /**
   * Assert that a set of changed (added/modified/deleted) paths contains no
   * protected artifacts. Throws CavGateError on the first protected path.
   */
  assertNoProtectedMutation(changedPaths: string[], role: string): void {
    for (const p of changedPaths) {
      if (this.isProtected(p)) {
        throw new CavGateError(
          `protected artifact would be mutated by role '${role}': ${p}. Acceptance criteria / sabotage fixtures / golden references / completion policy may not be silently rewritten to make an implementation pass.`,
        );
      }
    }
  }
}
