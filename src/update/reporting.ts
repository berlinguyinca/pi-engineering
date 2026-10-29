/**
 * How an update is spoken about (issue #484).
 *
 * `package.json` version is not bumped per commit, so `metadata.version` is
 * the same string for every release and a notice reading
 * `Pi Engineering 0.2.0 → 0.2.0` is indistinguishable from a no-op. The
 * identity that actually distinguishes a release is the version id — version
 * plus commit prefix — which is also the key `versions/<id>`, the journal and
 * telemetry are organised by.
 */

import { versionId } from "./installLayout.ts";

/** The parts of an installed version or fetch target that identify it. */
export interface RuntimeIdentity {
  version?: string | null;
  commit?: string | null;
}

/** `0.2.0-b662443f395d`, or `0.2.0` when no commit is recorded, or `unknown`. */
export function runtimeLabel(runtime: RuntimeIdentity | null | undefined): string {
  const version = runtime?.version;
  if (!version) return "unknown";
  return versionId(version, runtime.commit ?? null);
}

/** `0.2.0-b662443f395d → 0.2.0-d85a75898677` — the move an update reports. */
export function describeMove(from: RuntimeIdentity | null | undefined, to: RuntimeIdentity | null | undefined): string {
  return `${runtimeLabel(from)} → ${runtimeLabel(to)}`;
}
