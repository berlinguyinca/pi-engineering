import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** PE-side digest manifest of a skill pack. OMP's own `skills.lock.json` is a separate file. */
export const PACK_MANIFEST_FILE = "pack.manifest.json";
/** OMP lockfile name; excluded from the digest set (it records OMP's tarball integrity, not file digests). */
export const OMP_LOCK_FILE = "skills.lock.json";

export interface FileDigest {
  readonly sha256: string;
  /** SRI form `sha512-<base64>`, the same encoding OMP uses for tarball integrity. */
  readonly sha512: string;
}

export interface PackManifest {
  readonly manifestVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly files: Readonly<Record<string, FileDigest>>;
}

export interface PackVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

const EXCLUDED = new Set([PACK_MANIFEST_FILE, OMP_LOCK_FILE]);

interface Scan {
  readonly files: string[];
  readonly symlinks: string[];
}

/** Walk the pack with lstat semantics: symlinks are recorded, never followed or digested. */
function scan(root: string, dir = root, acc: Scan = { files: [], symlinks: [] }): Scan {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (entry.isSymbolicLink()) acc.symlinks.push(rel);
    else if (entry.isDirectory()) scan(root, full, acc);
    else if (!EXCLUDED.has(rel)) acc.files.push(rel);
  }
  acc.files.sort();
  return acc;
}

function digest(bytes: Buffer): FileDigest {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function packageIdentity(dir: string): { name: string; version: string } {
  const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const rec = pkg as { name?: unknown; version?: unknown } | null;
  if (typeof rec?.name !== "string" || typeof rec.version !== "string") {
    throw new Error("name and version must be strings");
  }
  return { name: rec.name, version: rec.version };
}

/** Compute the manifest for the pack as it is on disk now. Symlinks are skipped. */
export function buildPackManifest(dir: string): PackManifest {
  const files: Record<string, FileDigest> = {};
  for (const path of scan(dir).files) files[path] = digest(readFileSync(join(dir, path)));
  return { manifestVersion: 1, ...packageIdentity(dir), files };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function parseManifest(dir: string): PackManifest | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, PACK_MANIFEST_FILE), "utf8"));
  } catch (error) {
    return `manifest unreadable: ${message(error)}`;
  }
  if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.version !== "string" || !isRecord(raw.files)) {
    return "manifest malformed: expected {name, version, files: object}";
  }
  for (const [path, d] of Object.entries(raw.files)) {
    if (!isRecord(d) || typeof d.sha256 !== "string" || typeof d.sha512 !== "string") {
      return `manifest malformed: files.${path} needs string sha256 and sha512`;
    }
  }
  return raw as unknown as PackManifest;
}

const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

/**
 * Consistency of the pack's own skills.lock.json, computable without omp: every skills/<dir> has an
 * `@scope/<dir>` entry whose version equals package.json's and whose integrity is SHA-512 SRI.
 * NOT checked here (needs omp): that the integrity equals OMP's tarball hash; the gated integration
 * test recomputes it with `omp skill publish --dry-run`. An absent lock is allowed.
 */
function lockProblems(dir: string, version: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, OMP_LOCK_FILE), "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [`lock unreadable: ${message(error)}`];
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.skills))
    return ["lock malformed: expected {version: 1, skills: object}"];
  const problems: string[] = [];
  const entries = raw.skills;
  for (const [id, e] of Object.entries(entries)) {
    if (!isRecord(e) || typeof e.version !== "string" || typeof e.integrity !== "string") {
      problems.push(`lock malformed: ${id}`);
      continue;
    }
    if (e.version !== version) problems.push(`lock version mismatch: ${id} ${e.version} vs package.json ${version}`);
    if (!SRI_SHA512.test(e.integrity)) problems.push(`lock integrity is not sha512 SRI: ${id}`);
  }
  let skillDirs: string[] = [];
  try {
    skillDirs = readdirSync(join(dir, "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // no skills/ directory: nothing to pin
  }
  for (const name of skillDirs) {
    if (!Object.keys(entries).some((id) => id.endsWith(`/${name}`)))
      problems.push(`lock has no entry for skill: ${name}`);
  }
  return problems;
}

/** Compare the pack on disk with its recorded manifest. Never throws. */
export function verifyPack(dir: string): PackVerification {
  const recorded = parseManifest(dir);
  if (typeof recorded === "string") return { ok: false, problems: [recorded] };
  let identity: { name: string; version: string };
  let found: Scan;
  try {
    identity = packageIdentity(dir);
  } catch (error) {
    return { ok: false, problems: [`package.json unreadable: ${message(error)}`] };
  }
  try {
    found = scan(dir);
  } catch (error) {
    return { ok: false, problems: [`pack unreadable: ${message(error)}`] };
  }
  const problems: string[] = found.symlinks.map((p) => `symlink: ${p}`);
  if (recorded.name !== identity.name)
    problems.push(`name mismatch: manifest ${recorded.name} vs package.json ${identity.name}`);
  if (recorded.version !== identity.version) {
    problems.push(`version mismatch: manifest ${recorded.version} vs package.json ${identity.version}`);
  }
  for (const [path, want] of Object.entries(recorded.files)) {
    if (!found.files.includes(path)) {
      problems.push(`missing file: ${path}`);
      continue;
    }
    try {
      const got = digest(readFileSync(join(dir, path)));
      if (got.sha256 !== want.sha256 || got.sha512 !== want.sha512) problems.push(`digest mismatch: ${path}`);
    } catch (error) {
      problems.push(`unreadable file: ${path}: ${message(error)}`);
    }
  }
  for (const path of found.files) if (!(path in recorded.files)) problems.push(`unlisted file: ${path}`);
  problems.push(...lockProblems(dir, identity.version));
  return { ok: problems.length === 0, problems };
}
