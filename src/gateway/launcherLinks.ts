/**
 * Package links for the session auto-resume launcher.
 *
 * The launcher is a copy of the recovery code, and that code imports Pi's own packages
 * (`@earendil-works/pi-ai`). Those are linked into the install directory rather than
 * copied, so the recovery rules always see the Pi that is actually about to run. A managed
 * Pi install switches releases under the launcher, so the links are refreshed at every
 * start instead of being fixed when the launcher was installed.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The Pi package directory that owns `cli`: the nearest ancestor with a package.json. */
export function findPackageRoot(cli: string): string {
  for (let dir = dirname(cli); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) throw new Error("Cannot locate the original Pi package");
  }
}

/** The package directory `name` resolves to from the Pi package, as Node would find it. */
export function locatePackage(packageRoot: string, name: string): string {
  if (name === PI_PACKAGE) return packageRoot;
  for (let dir = packageRoot; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`Cannot locate ${name} for the launcher (needed by its recovery rules)`);
  }
}

/** Point `install/node_modules/<name>` at `target`. A stale link is replaced atomically; returns whether it changed. */
export function linkPackage(install: string, name: string, target: string): boolean {
  const link = join(install, "node_modules", name);
  mkdirSync(dirname(link), { recursive: true });
  const present = lstatSync(link, { throwIfNoEntry: false });
  if (present?.isSymbolicLink() && readlinkSync(link) === target) return false;
  if (present && !present.isSymbolicLink()) rmSync(link, { force: true, recursive: true });
  const staged = `${link}.relink-${process.pid}`;
  rmSync(staged, { force: true });
  symlinkSync(target, staged, "dir");
  renameSync(staged, link);
  return true;
}

/** Package names currently linked into the install directory. */
export function linkedPackages(install: string): string[] {
  const modules = join(install, "node_modules");
  if (!existsSync(modules)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith("@")) {
      for (const child of readdirSync(join(modules, entry))) {
        if (!child.includes(".relink-")) names.push(`${entry}/${child}`);
      }
    } else if (!entry.includes(".relink-")) {
      names.push(entry);
    }
  }
  return names;
}

/** Re-point every linked package at the Pi that owns `cli`. Returns the names that changed. */
export function refreshLinks(install: string, cli: string): string[] {
  const packageRoot = findPackageRoot(cli);
  const changed: string[] = [];
  for (const name of linkedPackages(install)) {
    let target: string;
    try {
      target = locatePackage(packageRoot, name);
    } catch {
      continue; // not provided by this Pi release; leave the link alone
    }
    if (linkPackage(install, name, target)) changed.push(name);
  }
  return changed;
}
