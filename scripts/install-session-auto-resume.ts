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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot, linkPackage, locatePackage } from "../src/gateway/launcherLinks.ts";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// `--managed [agentDir]` hooks the launcher into a managed Pi install (`~/.pi/agent/bin/pi`)
// instead of replacing a `pi` on PATH; see the end of this file.
const managed = process.argv[2] === "--managed";
const args = process.argv.slice(managed ? 3 : 2);
const agentDir = resolve(managed ? (args[0] ?? join(homedir(), ".pi/agent")) : "");
const bin = managed ? join(agentDir, "bin/pi") : resolve(args[0] ?? join(homedir(), ".local/bin/pi"));
const install = resolve(args[1] ?? join(homedir(), ".local/share/pi-session-auto-resume"));
const manifest = join(install, "install.json");
const marker = "# pi-session-auto-resume launcher";
const hookBegin = "# >>> pi-session-auto-resume (installed by pi-engineering) >>>";
const hookEnd = "# <<< pi-session-auto-resume <<<";
const wrapperExec = 'exec "$pi_release_bin" "$@"';
const previous =
  !managed && existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")) as { originalCli: string })
    : undefined;
if (!existsSync(bin)) throw new Error(`Pi launcher does not exist: ${bin}`);
const stat = lstatSync(bin);
if (managed) {
  const text = stat.isSymbolicLink() ? "" : readFileSync(bin, "utf8");
  if (!text.includes(wrapperExec) && !text.includes(hookBegin)) {
    throw new Error(`Not a managed Pi wrapper (no \`${wrapperExec}\` line): ${bin}`);
  }
} else if (!stat.isSymbolicLink() && !readFileSync(bin, "utf8").includes(marker)) {
  throw new Error(`Refusing to replace an unrecognized regular launcher: ${bin}`);
}
const managedRelease = managed
  ? join(agentDir, "install/releases", readFileSync(join(agentDir, "install/current-version"), "utf8").trim())
  : "";
const originalCli = managed
  ? realpathSync(join(managedRelease, "node_modules/.bin/pi"))
  : (previous?.originalCli ?? realpathSync(bin));
if (!existsSync(originalCli)) throw new Error(`Original Pi CLI is missing: ${originalCli}`);
const packageRoot = findPackageRoot(originalCli);
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
// Packages only the optional runtime-selection step imports: where this Pi does not bundle one, the
// launcher still installs and that step falls back to standard Pi at start (it never blocks Pi).
const optionalPackages = new Set(["yaml"]);
for (const name of packages) {
  try {
    linkPackage(install, name, locatePackage(packageRoot, name));
  } catch (error) {
    if (!optionalPackages.has(name)) throw error;
    console.warn(`Optional package ${name} not found in this Pi; pi_runtime selection will fall back to standard Pi`);
  }
}
if (managed) {
  installManagedHook();
  process.exit(0);
}
if (!existsSync(`${bin}.before-session-auto-resume`)) symlinkSync(originalCli, `${bin}.before-session-auto-resume`);
writeFileSync(manifest, JSON.stringify({ originalCli, bin }, null, 2), { mode: 0o600 });
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

/**
 * Hook the launcher into the managed wrapper, just before its final `exec`. The wrapper
 * already resolves the current release and exports its environment; the hook only swaps
 * what it execs. If the launcher is missing, or node cannot run TypeScript, the next line
 * starts Pi exactly as before, so the hook can never make Pi unstartable. The hook is one
 * marked block, so running this again replaces it instead of adding a second.
 */
function installManagedHook(): void {
  const text = readFileSync(bin, "utf8");
  const launcher = join(install, "scripts/pi-session-auto-resume.ts");
  // The launcher is run once with --check first: that proves node can load it (type
  // stripping, a complete file) before Pi is handed over, since an exec cannot be undone.
  const hook = [
    hookBegin,
    `pi_resume_launcher=${quote(launcher)}`,
    'if [ -r "$pi_resume_launcher" ] && [ -z "${PI_SESSION_AUTO_RESUME_BYPASS:-}" ] \\',
    "  && command -v node >/dev/null 2>&1 \\",
    '  && node "$pi_resume_launcher" --check >/dev/null 2>&1; then',
    '  exec node "$pi_resume_launcher" "$pi_release_bin" "$@"',
    "fi",
    hookEnd,
  ].join("\n");
  const begin = text.indexOf(hookBegin);
  const end = text.indexOf(hookEnd);
  if (begin >= 0 !== end >= 0 || end < begin) {
    throw new Error(`The hook markers in ${bin} are damaged; restore ${bin}.before-session-auto-resume first`);
  }
  let next: string;
  if (begin >= 0) {
    next = `${text.slice(0, begin)}${hook}${text.slice(end + hookEnd.length)}`;
  } else {
    // The wrapper's own final exec, not an earlier mention of it. Built from slices, not
    // String.replace: replacement strings give `$` sequences a meaning, and this text is shell.
    const at = text.lastIndexOf(wrapperExec);
    next = `${text.slice(0, at)}${hook}\n${text.slice(at)}`;
    // Keep the pristine wrapper from the first hook; later runs must not overwrite it.
    if (!existsSync(`${bin}.before-session-auto-resume`)) copyFileSync(bin, `${bin}.before-session-auto-resume`);
  }
  if (next === text) {
    console.log(`Refreshed automatic safe session recovery files in ${install}; ${bin} already hooks them`);
    return;
  }
  const staged = `${bin}.session-auto-resume-${process.pid}`;
  try {
    writeFileSync(staged, next, { mode: statSync(bin).mode & 0o777 });
    renameSync(staged, bin);
  } finally {
    rmSync(staged, { force: true });
  }
  console.log(
    `Hooked automatic safe session recovery into ${bin}\nPi release: ${originalCli}\nOriginal wrapper: ${bin}.before-session-auto-resume`,
  );
}
