/**
 * CAV-21 Shared-Project Portability: the acceptance state (steps, evidence,
 * status) must be portable across project checkouts and machines.
 *
 * Portability means: a CAV manifest carries machine-readable evidence with no
 * machine-specific absolute paths or host identifiers baked in, and the status
 * derived from a manifest is identical regardless of which checkout it is
 * loaded from. This validates the shared-project handoff contract (WeaveForge).
 */
import type { CavEvidenceLedger } from "./evidence.ts";

export interface PortableEvidenceEntry {
  requirement_id: string;
  status: string;
  role: string;
  gate: string;
  exit_code: number;
  git_sha: string;
  command: string;
}

export interface PortabilityManifest {
  format: "cav-portable-manifest";
  version: number;
  exported_at: string;
  evidence: PortableEvidenceEntry[];
}

export interface PortabilityCheck {
  portable: boolean;
  absolutePathCount: number;
  hostnameCount: number;
  entries: number;
  blockers: string[];
}

const ABS_PATH_RE = /\/(?:home|Users|tmp)\//;
const HOST_RE = /\b(?:localhost|127\.0\.0\.1|[\w.-]+\.local)\b/i;

/**
 * Build a portable manifest from the evidence ledger. Artifact paths and
 * commands are retained as relative references only where possible; entries
 * whose command embeds a machine-specific absolute path are flagged.
 */
export async function buildPortableManifest(ledger: CavEvidenceLedger): Promise<PortabilityManifest> {
  const all = ledger.all();
  return {
    format: "cav-portable-manifest",
    version: 1,
    exported_at: new Date().toISOString(),
    evidence: all.map((e) => ({
      requirement_id: e.requirement_id,
      status: e.status,
      role: e.role,
      gate: e.gate_type,
      exit_code: e.exit_code,
      git_sha: e.git_sha,
      command: e.command,
    })),
  };
}

/** Validate that a manifest is portable (no machine-specific absolute paths). */
export function checkPortability(manifest: PortabilityManifest): PortabilityCheck {
  const blockers: string[] = [];
  let absolutePathCount = 0;
  let hostnameCount = 0;
  for (const e of manifest.evidence) {
    if (ABS_PATH_RE.test(e.command)) {
      absolutePathCount++;
      blockers.push(`entry ${e.requirement_id} command has an absolute path`);
    }
    if (HOST_RE.test(e.command)) {
      hostnameCount++;
      blockers.push(`entry ${e.requirement_id} command has a hostname`);
    }
  }
  return {
    portable: blockers.length === 0,
    absolutePathCount,
    hostnameCount,
    entries: manifest.evidence.length,
    blockers,
  };
}

/**
 * Reconstruct status from a portable manifest. The derived status must be
 * identical no matter which checkout loads it (deterministic from entries).
 */
export function derivePortableStatus(manifest: PortabilityManifest): Record<string, string> {
  const status: Record<string, string> = {};
  for (const e of manifest.evidence) {
    // Latest record wins, matching the live ledger's semantics.
    status[e.requirement_id] = e.status;
  }
  return status;
}
