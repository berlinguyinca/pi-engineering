/**
 * VisionAssetManager — content-addressed cache + asset lifecycle for vision
 * payload assets (spec: pi-engineering-vision-payload-management).
 *
 * Lifecycle: NEW -> ACTIVE_ANALYSIS -> OBSERVATION_EXTRACTED -> OFFLOADED.
 * Pure deterministic logic over plain structured metadata; no image decoding.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export type AssetStatus = "NEW" | "ACTIVE_ANALYSIS" | "OBSERVATION_EXTRACTED" | "OFFLOADED";

export interface VisionAsset {
  assetId: string;
  sourcePath: string;
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  originalBytes: number;
  createdAt: string;
  status: AssetStatus;
}

const LIFECYCLE: readonly AssetStatus[] = ["NEW", "ACTIVE_ANALYSIS", "OBSERVATION_EXTRACTED", "OFFLOADED"];

/** Advance an asset status one step through its lifecycle; OFFLOADED is terminal. */
export function nextStatus(s: AssetStatus): AssetStatus {
  const idx = LIFECYCLE.indexOf(s);
  if (idx === -1 || idx === LIFECYCLE.length - 1) return s;
  return LIFECYCLE[idx + 1] as AssetStatus;
}

/**
 * In-memory content-addressed cache + lifecycle tracker for vision assets.
 * Path helpers are pure string builders; analysis caching consults the
 * on-disk `analysis.json` in addition to in-memory flags.
 */
export class VisionAssetManager {
  readonly cacheRoot: string;

  private readonly byId = new Map<string, VisionAsset>();
  private readonly bySha = new Map<string, VisionAsset>();
  private readonly analyzed = new Set<string>();
  private readonly schemaVersions = new Map<string, string>();

  constructor(cacheRoot = ".vision-cache") {
    this.cacheRoot = cacheRoot;
  }

  cacheDir(sha256: string): string {
    return join(this.cacheRoot, sha256);
  }

  derivativePath(sha256: string): string {
    return join(this.cacheDir(sha256), "vision.jpg");
  }

  analysisJsonPath(sha256: string): string {
    return join(this.cacheDir(sha256), "analysis.json");
  }

  analysisMdPath(sha256: string): string {
    return join(this.cacheDir(sha256), "analysis.md");
  }

  /** Store an asset in the in-memory maps keyed by assetId and by sha256. */
  register(asset: VisionAsset): void {
    this.byId.set(asset.assetId, asset);
    this.bySha.set(asset.sha256, asset);
  }

  getBySha256(sha256: string): VisionAsset | undefined {
    return this.bySha.get(sha256);
  }

  /** True when analysis.json exists on disk or the in-memory analyzed flag was set. */
  hasCachedAnalysis(sha256: string): boolean {
    if (this.analyzed.has(sha256)) return true;
    return existsSync(this.analysisJsonPath(sha256));
  }

  /** Mark an asset analyzed in memory and advance its lifecycle status. */
  markAnalyzed(sha256: string, schemaVersion?: string): void {
    this.analyzed.add(sha256);
    if (schemaVersion !== undefined) {
      this.schemaVersions.set(sha256, schemaVersion);
    }
    const asset = this.bySha.get(sha256);
    if (asset && asset.status === "NEW") {
      const advanced: VisionAsset = { ...asset, status: "ACTIVE_ANALYSIS" };
      this.bySha.set(sha256, advanced);
      this.byId.set(asset.assetId, advanced);
    }
  }

  /**
   * True when the asset must be re-analyzed: force flag set, the source
   * sha256 differs from the stored one, or the tracked schema version differs
   * from the current schema version. False on a cache hit (nothing changed).
   */
  shouldReanalyze(asset: VisionAsset, currentSchemaVersion: string, opts: { force?: boolean } = {}): boolean {
    if (opts.force) return true;
    const stored = this.bySha.get(asset.sha256);
    if (!stored) return true;
    if (stored.sha256 !== asset.sha256) return true;
    if (this.schemaVersions.get(asset.sha256) !== currentSchemaVersion) return true;
    return false;
  }

  assetStatus(assetId: string): AssetStatus | undefined {
    return this.byId.get(assetId)?.status;
  }
}
