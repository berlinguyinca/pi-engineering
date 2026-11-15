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

function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, full));
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out.filter((p) => !EXCLUDED.has(p)).sort();
}

function digest(bytes: Buffer): FileDigest {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function packageIdentity(dir: string): { name: string; version: string } {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string };
  return { name: pkg.name, version: pkg.version };
}

/** Compute the manifest for the pack as it is on disk now. */
export function buildPackManifest(dir: string): PackManifest {
  const files: Record<string, FileDigest> = {};
  for (const path of listFiles(dir)) files[path] = digest(readFileSync(join(dir, path)));
  return { manifestVersion: 1, ...packageIdentity(dir), files };
}

/** Compare the pack on disk with its recorded manifest. Never throws on a bad manifest. */
export function verifyPack(dir: string): PackVerification {
  let recorded: PackManifest;
  try {
    recorded = JSON.parse(readFileSync(join(dir, PACK_MANIFEST_FILE), "utf8")) as PackManifest;
  } catch (error) {
    return { ok: false, problems: [`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const problems: string[] = [];
  const actual = buildPackManifest(dir);
  if (recorded.version !== actual.version) {
    problems.push(`version mismatch: manifest ${recorded.version} vs package.json ${actual.version}`);
  }
  for (const [path, want] of Object.entries(recorded.files)) {
    const got = actual.files[path];
    if (!got) problems.push(`missing file: ${path}`);
    else if (got.sha256 !== want.sha256 || got.sha512 !== want.sha512) problems.push(`digest mismatch: ${path}`);
  }
  for (const path of Object.keys(actual.files)) {
    if (!recorded.files[path]) problems.push(`unlisted file: ${path}`);
  }
  return { ok: problems.length === 0, problems };
}
