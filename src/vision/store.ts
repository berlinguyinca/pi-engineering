/**
 * VisionObservationStore — persistence of DesignObservations + traceability
 * (spec: pi-engineering-vision-payload-management-413-recovery, §41, Phase 3).
 *
 * Persists per-reference `.analysis.json` (a DesignObservation/v1 wrapper) and
 * `.analysis.md` under a configurable root. Pure node:fs persistence over
 * plain structured inputs; no image decoding.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION, validateDesignObservation } from "./observation.ts";
import type { DesignObservation } from "./observation.ts";

export const DEFAULT_ANALYSIS_ROOT = "docs/specs/aims-console/design/analysis";

interface StoredObservation {
  schemaVersion: string;
  observation: DesignObservation;
}

/** Persistence of DesignObservation artifacts keyed by design reference. */
export class VisionObservationStore {
  readonly root: string;

  constructor(root = DEFAULT_ANALYSIS_ROOT) {
    this.root = root;
  }

  /** `<root>/<reference>.analysis.json` */
  analysisJsonPath(reference: string): string {
    return join(this.root, `${reference}.analysis.json`);
  }

  /** `<root>/<reference>.analysis.md` */
  analysisMdPath(reference: string): string {
    return join(this.root, `${reference}.analysis.md`);
  }

  /** Write the analysis.json (DesignObservation/v1 wrapper) and analysis.md. */
  save(reference: string, observation: DesignObservation, md: string): void {
    const stored: StoredObservation = {
      schemaVersion: SCHEMA_VERSION,
      observation,
    };
    const jsonPath = this.analysisJsonPath(reference);
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    const mdPath = this.analysisMdPath(reference);
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, md, "utf8");
  }

  /** Read + validate the stored observation; null when missing or invalid. */
  load(reference: string): { observation: DesignObservation; schemaVersion: string } | null {
    const jsonPath = this.analysisJsonPath(reference);
    if (!existsSync(jsonPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const stored = parsed as Partial<StoredObservation>;
    if (typeof stored.schemaVersion !== "string") return null;
    if (stored.observation === undefined) return null;
    if (validateDesignObservation(stored.observation).length > 0) return null;
    return { observation: stored.observation, schemaVersion: stored.schemaVersion };
  }

  /** True when a valid analysis.json exists on disk for the reference. */
  has(reference: string): boolean {
    return this.load(reference) !== null;
  }
}

/** A requirement traceable back to one or more design references. */
export interface TraceabilityRecord {
  requirement: string;
  sources: { reference: string; region?: string }[];
}

const REQUIREMENT_REGIONS = ["components", "navigation", "reusablePatterns", "accessibilityNotes"] as const;

/**
 * Derive requirements from each observation's components/navigation/
 * reusablePatterns/accessibilityNotes (each string item becomes a requirement
 * tagged with its provenance). Records are deduped by requirement text and
 * merged across references.
 */
export function buildTraceability(observations: DesignObservation[]): TraceabilityRecord[] {
  const byRequirement = new Map<string, TraceabilityRecord>();
  for (const obs of observations) {
    for (const region of REQUIREMENT_REGIONS) {
      const items = obs[region] as readonly string[];
      for (const requirement of items) {
        let record = byRequirement.get(requirement);
        if (!record) {
          record = { requirement, sources: [] };
          byRequirement.set(requirement, record);
        }
        if (!record.sources.some((s) => s.reference === obs.reference && s.region === region)) {
          record.sources.push({ reference: obs.reference, region });
        }
      }
    }
  }
  return [...byRequirement.values()];
}
