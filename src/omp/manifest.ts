import type { OmpPinManifest, SemVer } from "./types.ts";

/**
 * Validated against oh-my-pi 18.20.0 at commit 57263720c818ab3baaeb74bf415b03592b806ae0.
 * Bump only after re-running the integration test against the new build.
 */
export const OMP_PIN_MANIFEST: OmpPinManifest = {
  minVersion: { major: 18, minor: 20, patch: 0 },
  maxVersionExclusive: { major: 18, minor: 21, patch: 0 },
  acceptedProtocolVersions: [1, 2],
  validatedAgainstCommit: "57263720c818ab3baaeb74bf415b03592b806ae0",
};

/** Parse strict `X.Y.Z` (optionally `v`-prefixed). Pre-release/build suffixes are rejected (null): only releases are pinned. */
export function parseSemVer(input: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(input.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isVersionPinned(version: SemVer, manifest: OmpPinManifest): boolean {
  return compareSemVer(version, manifest.minVersion) >= 0 && compareSemVer(version, manifest.maxVersionExclusive) < 0;
}

/** Extract the version from `omp --version` output (`omp/18.20.0`). Null when absent. */
export function parseVersionOutput(stdout: string): string | null {
  const m = /\bomp\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)/.exec(stdout);
  return m?.[1] ?? null;
}
