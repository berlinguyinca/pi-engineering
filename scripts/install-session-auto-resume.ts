#!/usr/bin/env node
/** Install a reversible user-local Pi launcher, preserving the original CLI. */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const bin = resolve(process.argv[2] ?? join(homedir(), ".local/bin/pi"));
const install = resolve(process.argv[3] ?? join(homedir(), ".local/share/pi-session-auto-resume"));
const manifest = join(install, "install.json");
const marker = "# pi-session-auto-resume launcher";
const previous = existsSync(manifest)
  ? (JSON.parse(readFileSync(manifest, "utf8")) as { originalCli: string })
  : undefined;
if (!existsSync(bin)) throw new Error(`Pi launcher does not exist: ${bin}`);
const stat = lstatSync(bin);
if (!stat.isSymbolicLink() && !readFileSync(bin, "utf8").includes(marker)) {
  throw new Error(`Refusing to replace an unrecognized regular launcher: ${bin}`);
}
const originalCli = previous?.originalCli ?? realpathSync(bin);
if (!existsSync(originalCli)) throw new Error(`Original Pi CLI is missing: ${originalCli}`);
let packageRoot = dirname(originalCli);
while (!existsSync(join(packageRoot, "package.json"))) {
  const parent = dirname(packageRoot);
  if (parent === packageRoot) throw new Error("Cannot locate the original Pi package");
  packageRoot = parent;
}
if (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") {
  throw new Error("Original launcher does not belong to the Pi coding agent");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The launcher is a copy of the code it runs, so it must carry everything that
 * code imports. Walk the import graph from the wrapper instead of listing files
 * by hand: a hand-kept list silently went stale once the recovery rules began
 * to share the classifier modules, and a stale list is a launcher that cannot
 * load. Relative imports are copied; bare package imports are linked below.
 */
const importPattern =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const files = new Set<string>();
const packages = new Set<string>();
const pending = ["scripts/pi-session-auto-resume.ts"];
while (pending.length > 0) {
  const file = pending.pop()!;
  if (files.has(file)) continue;
  files.add(file);
  for (const match of readFileSync(join(root, file), "utf8").matchAll(importPattern)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (!spec || spec.startsWith("node:")) continue;
    if (spec.startsWith(".")) {
      const target = relative(root, resolve(root, dirname(file), spec))
        .split(sep)
        .join("/");
      if (!existsSync(join(root, target))) throw new Error(`${file} imports ${spec}, which does not exist`);
      pending.push(target);
    } else {
      const parts = spec.split("/");
      packages.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string));
    }
  }
}
for (const file of files) {
  mkdirSync(join(install, dirname(file)), { recursive: true });
  // Copy beside, then rename: a Pi starting mid-install never reads a half-written file.
  const staged = join(install, `${file}.installing-${process.pid}`);
  copyFileSync(join(root, file), staged);
  renameSync(staged, join(install, file));
}
writeFileSync(join(install, "package.json"), JSON.stringify({ private: true, type: "module" }));
/** The package directory `name` resolves to from the original Pi package, as Node would find it. */
function locatePackage(name: string): string {
  if (name === "@earendil-works/pi-coding-agent") return packageRoot;
  for (let dir = packageRoot; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`Cannot locate ${name} for the launcher (needed by its recovery rules)`);
  }
}
for (const name of packages) {
  const link = join(install, "node_modules", name);
  mkdirSync(dirname(link), { recursive: true });
  // Replace a stale link from an earlier install: the Pi package may have moved.
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { force: true, recursive: true });
  symlinkSync(locatePackage(name), link, "dir");
}
if (!existsSync(`${bin}.before-session-auto-resume`)) symlinkSync(originalCli, `${bin}.before-session-auto-resume`);
writeFileSync(manifest, JSON.stringify({ originalCli, bin }, null, 2), { mode: 0o600 });
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const target = `${quote(join(install, "scripts/pi-session-auto-resume.ts"))} ${quote(originalCli)} "$@"`;
// A launcher that already runs this install keeps its file as it is: operators add
// their own lines to it (load limits, search config), and a rewrite from the
// template would silently drop them. The copied files above are what changed.
// Only a real `exec` line counts, and the node it names must still exist.
const existing = stat.isSymbolicLink() ? "" : readFileSync(bin, "utf8");
const execLine = existing
  .split("\n")
  .find((line) => line.startsWith("exec ") && line.endsWith(target) && line.slice(5, -target.length).trim() !== "");
const execNode = execLine
  ?.slice(5, -target.length)
  .trim()
  .replace(/^'(.*)'$/, "$1");
if (existing.includes(marker) && execNode && existsSync(execNode)) {
  console.log(
    `Refreshed automatic safe session recovery files in ${install}; ${bin} already uses them and was left unchanged`,
  );
} else {
  // A rewrite replaces the whole file: keep what was there, in case it held operator lines.
  if (!stat.isSymbolicLink() && existing.includes(marker)) copyFileSync(bin, `${bin}.pre-rewrite`);
  const temporary = `${bin}.session-auto-resume-${process.pid}`;
  writeFileSync(temporary, `#!/bin/sh\n${marker}\nexec ${quote(process.execPath)} ${target}\n`, { mode: 0o755 });
  renameSync(temporary, bin);
  console.log(
    `Installed automatic safe session recovery at ${bin}\nOriginal CLI: ${originalCli}\nBackup launcher: ${bin}.before-session-auto-resume`,
  );
}
