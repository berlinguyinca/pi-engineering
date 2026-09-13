/**
 * Test-impact analysis (spec §15.4, backlog B-107).
 *
 * Given a set of changed source paths, determine which tests are affected and
 * must run. Two deterministic signals:
 *
 *   1. Convention: `src/foo/bar.ts` -> `test/foo/bar.test.ts` (or `*.spec.ts`,
 *      or co-located `bar.test.ts`).
 *   2. Import graph: tests that transitively import a changed module.
 *
 * Pure and dependency-free: imports are resolved via regex over relative
 * `import ... from './x'` statements with a candidate-extension set, which is
 * sufficient for targeting (not for resolution semantics).
 */
export interface TestTarget {
  path: string;
  /** Why this test is affected. */
  reason: "convention" | "import" | "direct";
}

export function isTestFile(p: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(p);
}

const IMPORT_RE = /import\s+(?:[^'"]+\s+from\s+)?["'](\.[^"']+)["']/g;

/** Normalize a/b/../c and ./ segments (no fs). */
export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/** Resolve a relative import to a candidate module path (no fs). */
export function resolveImport(fromDir: string, spec: string): string {
  const clean = spec.replace(/^\.\//, "").replace(/\.(ts|js|tsx|jsx|mjs|cjs)$/, "");
  return normalizePath(`${fromDir}/${clean}`);
}

/**
 * Map changed source paths to affected test files using conventions + the
 * import graph of the given test files.
 *
 * @param changedPaths   changed source paths (relative).
 * @param testFiles      all known test files (relative), with their contents
 *                       used to build the reverse import graph.
 */
export function impactedTests(
  changedPaths: string[],
  testFiles: Array<{ path: string; content: string }>,
): TestTarget[] {
  const changed = new Set(changedPaths.map((p) => p.replace(/^\.\//, "")));
  const targets = new Map<string, TestTarget>();
  const add = (path: string, reason: TestTarget["reason"]) => {
    if (!targets.has(path)) targets.set(path, { path, reason });
  };

  // Convention: changed source maps to a sibling test.
  for (const p of changed) {
    if (isTestFile(p)) {
      add(p, "direct");
      continue;
    }
    const base = p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    const candidates = [
      base.replace(/^src\//, "test/") + ".test.ts",
      base.replace(/^src\//, "test/") + ".spec.ts",
      base + ".test.ts",
    ];
    for (const c of candidates) {
      if (testFiles.some((t) => t.path === c)) {
        add(c, "convention");
        break;
      }
    }
  }

  // Import graph: a test affected if it (transitively) imports a changed module.
  const byModule = new Map<string, string[]>();
  for (const t of testFiles) {
    const dir = t.path.includes("/") ? t.path.slice(0, t.path.lastIndexOf("/")) : "";
    const imports: string[] = [];
    const re = new RegExp(IMPORT_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(t.content)) !== null) {
      const spec = m[1]!;
      if (!spec.startsWith(".")) continue;
      imports.push(resolveImport(dir, spec));
    }
    for (const imp of imports) {
      const arr = byModule.get(imp) ?? [];
      arr.push(t.path);
      byModule.set(imp, arr);
    }
  }
  for (const p of changed) {
    const module = p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
    const importers = byModule.get(module) ?? [];
    for (const imp of importers) add(imp, "import");
  }

  return [...targets.values()].sort((a, b) => a.path.localeCompare(b.path));
}
