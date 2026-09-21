/**
 * BAR-000 — Bootstrap & dogfood: define scope and inputs.
 *
 * This is the root-of-trust step for auditing the Pi Engineering/CAV codebase
 * itself. Before any requirement is reconstructed or any historical claim is
 * trusted, the audit must fix WHAT is in scope and WHERE the evidence comes
 * from. This module defines a machine-readable, immutable audit scope and
 * captures the audit inputs (source revision, environment fingerprint, and the
 * deterministic on-disk discovery inventory) with provenance.
 *
 * It reconciles with the existing CAV architecture (src/cav), Engineering
 * Ledger (src/ledger) and BAR engine (src/bar): it reuses discoverRepo for the
 * inventory and environmentFingerprint for the environment record rather than
 * introducing a parallel scanning/verification framework. Historical success
 * claims are untrusted inputs; the scope is derived from the on-disk structure,
 * never from a historical claim.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { id } from "../core/ids.ts";
import { environmentFingerprint } from "./baseline.ts";
import { type DiscoveryInput, discoverRepo } from "./discovery.ts";

export interface ScopeOpts {
  /** In-scope relative directories (the audit surfaces). Must be non-empty. */
  includeDirs: string[];
  /** Extra relative directories excluded in addition to the defaults. */
  excludeDirs?: string[];
  /** Root-level files that are always treated as audit inputs. */
  includeFiles?: string[];
  /** Maximum discovery depth (passed through to discoverRepo). */
  maxDepth?: number;
  /** Project display name (defaults to the repository directory name). */
  project?: string;
  /** Provenance files whose hashes pin this scope (defaults to BAR spec pack). */
  provenanceFiles?: string[];
}

export interface ScopeProvenance {
  file: string;
  hash: string;
}

export interface AuditScope {
  scopeId: string;
  project: string;
  sourceRevision: string | null;
  environment: { platform: string; node: string; cwd: string; fingerprint: string };
  includeDirs: string[];
  excludeDirs: string[];
  surfaces: string[];
  inputs: DiscoveryInput;
  provenance: ScopeProvenance[];
  createdAt: string;
  immutable: true;
}

const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", "coverage", ".next", ".pi-eng"];

const DEFAULT_PROVENANCE_FILES = [
  "docs/specs/bar/MASTER.md",
  "docs/specs/bar/ROADMAP.md",
  "docs/specs/bar/steps/000-bootstrap-dogfood-define-scope-and-inputs.md",
];

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Resolve HEAD revision deterministically; null when not a git repo. */
export function sourceRevision(root: string): string | null {
  try {
    const out = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** True when a relative path lives inside an included surface or is an include file. */
export function isInScope(rel: string, includeDirs: string[], includeFiles: string[]): boolean {
  if (includeFiles.includes(rel)) return true;
  return includeDirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

/** Filter a discovery inventory down to the declared in-scope surfaces. */
export function filterDiscovery(
  discovery: DiscoveryInput,
  includeDirs: string[],
  includeFiles: string[],
): DiscoveryInput {
  const keep = (rel: string): boolean => isInScope(rel, includeDirs, includeFiles);
  return {
    ...discovery,
    specs: discovery.specs.filter(keep),
    sourceFiles: discovery.sourceFiles.filter(keep),
    testFiles: discovery.testFiles.filter(keep),
    configFiles: discovery.configFiles.filter(keep),
    historicalClaims: discovery.historicalClaims.filter(keep),
    entrypoints: discovery.entrypoints.filter(keep),
  };
}

/**
 * Define an immutable audit scope for a repository.
 *
 * Deterministic failures (never overridable by model judgment):
 *  - an empty `includeDirs` is rejected — a scope that audits nothing cannot
 *    establish a root of trust;
 *  - every include dir must actually exist under the repo root — the scope is
 *    derived from reality, not from a historical claim.
 */
export function defineScope(root: string, opts: ScopeOpts): AuditScope {
  if (!opts.includeDirs || opts.includeDirs.length === 0) {
    throw new Error("defineScope: includeDirs must contain at least one in-scope directory");
  }
  const rootAbs = resolve(root);
  const normalized = opts.includeDirs.map((d) => relative(rootAbs, resolve(rootAbs, d)).replace(/\\/g, "/"));
  const includeFiles = (opts.includeFiles ?? []).map((f) => relative(rootAbs, resolve(rootAbs, f)).replace(/\\/g, "/"));
  const excludeDirs = [...DEFAULT_EXCLUDE_DIRS, ...(opts.excludeDirs ?? [])];

  // Every declared surface must exist on disk.
  for (const dir of normalized) {
    const full = join(rootAbs, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      throw new Error(`defineScope: include dir does not exist under repo root: ${dir}`);
    }
  }

  const discovered = discoverRepo(rootAbs, { maxDepth: opts.maxDepth, ignoreDirs: excludeDirs });
  const inputs = filterDiscovery(discovered, normalized, includeFiles);

  const provenanceFiles = opts.provenanceFiles ?? DEFAULT_PROVENANCE_FILES;
  const provenance: ScopeProvenance[] = provenanceFiles.map((f) => {
    const rel = relative(rootAbs, resolve(rootAbs, f)).replace(/\\/g, "/");
    try {
      const raw = readFileSync(join(rootAbs, rel), "utf-8");
      return { file: rel, hash: sha256Hex(raw) };
    } catch {
      // A missing provenance file is recorded as a sentinel so the gap is visible.
      return { file: rel, hash: "MISSING" };
    }
  });

  return {
    scopeId: id("BARSCOPE"),
    project: opts.project ?? basenameSafe(rootAbs),
    sourceRevision: sourceRevision(rootAbs),
    environment: {
      platform: process.platform,
      node: process.versions?.node ?? "unknown",
      cwd: rootAbs,
      fingerprint: environmentFingerprint(rootAbs),
    },
    includeDirs: normalized,
    excludeDirs,
    surfaces: normalized,
    inputs,
    provenance,
    createdAt: new Date().toISOString(),
    immutable: true,
  };
}

function basenameSafe(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
