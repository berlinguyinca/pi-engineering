/**
 * Structural (AST-based) questions about Pi's own source for the GAP tests: which modules are reachable from the
 * product entry points, which of them CALL a function, which contain a given string literal. Uses the TypeScript
 * parser (no text grep, so comments and unrelated substrings cannot satisfy or break a check).
 *
 * Entry points: package.json `pi.extensions` and `bin`, plus extensions/index.ts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export const PI_ROOT = resolve(import.meta.dirname, "../../..");

const cache = new Map<string, ts.SourceFile>();
export function parse(file: string): ts.SourceFile {
  let sf = cache.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    cache.set(file, sf);
  }
  return sf;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile() && c.endsWith(".ts")) return c;
  }
  return null;
}

export function importsOf(file: string): string[] {
  const out: string[] = [];
  walk(parse(file), (n) => {
    let spec: string | undefined;
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    )
      spec = n.moduleSpecifier.text;
    else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    )
      spec = n.arguments[0].text;
    const r = spec ? resolveImport(file, spec) : null;
    if (r) out.push(r);
  });
  return out;
}

export function entryPoints(): string[] {
  const pkg = JSON.parse(readFileSync(join(PI_ROOT, "package.json"), "utf8"));
  const rel: string[] = [
    ...(pkg.pi?.extensions ?? []),
    ...Object.values<string>(pkg.bin ?? {}),
    "./extensions/index.ts",
  ];
  return rel.map((r) => resolve(PI_ROOT, r)).filter((f) => existsSync(f) && f.endsWith(".ts"));
}

/** Every module reachable from the product entry points through static or literal-dynamic relative imports. */
export function reachable(entries: string[] = entryPoints()): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    queue.push(...importsOf(f));
  }
  return seen;
}

export const rel = (f: string): string => relative(PI_ROOT, f);

/** Files in `reach` (minus `except`) containing a call to any of `names` (`f()` or `x.f()`). */
export function callers(reach: Iterable<string>, names: string[], except: string[] = []): string[] {
  const hit: string[] = [];
  for (const f of reach) {
    if (except.includes(rel(f))) continue;
    let found = false;
    walk(parse(f), (n) => {
      if (!ts.isCallExpression(n)) return;
      const e = n.expression;
      const id = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "";
      if (names.includes(id)) found = true;
    });
    if (found) hit.push(rel(f));
  }
  return hit.sort();
}

/** Files in `reach` (minus `except`) with a string literal / template chunk / identifier matching `re`. */
export function mentions(reach: Iterable<string>, re: RegExp, except: string[] = []): string[] {
  const hit: string[] = [];
  for (const f of reach) {
    if (except.includes(rel(f))) continue;
    let found = false;
    walk(parse(f), (n) => {
      if (
        (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) &&
        re.test(n.text)
      )
        found = true;
      else if (ts.isIdentifier(n) && re.test(n.text)) found = true;
    });
    if (found) hit.push(rel(f));
  }
  return hit.sort();
}

/** All .ts files below the given directories of the Pi checkout. */
export function allSources(dirs: string[]): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      if (f === "node_modules") continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) rec(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  for (const d of dirs) rec(join(PI_ROOT, d));
  return out;
}

/** Names of the methods that (directly) contain a call to `name` in `file`. */
export function enclosingMethods(file: string, name: string): string[] {
  const out: string[] = [];
  walk(parse(file), (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name) {
      let p: ts.Node | undefined = n.parent;
      while (p && !ts.isMethodDeclaration(p) && !ts.isFunctionDeclaration(p)) p = p.parent;
      out.push(p && (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) ? (p.name?.getText() ?? "?") : "<top>");
    }
  });
  return out;
}
