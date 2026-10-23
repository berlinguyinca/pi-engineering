/**
 * `forks:` block of the GLOBAL `engineering.yaml` (T13). YAML only: there is no flag and no environment variable, and
 * a repository file cannot turn forks on. Anything malformed turns the feature OFF with a note, never partly on.
 *
 *   forks:
 *     enabled: true            # default false
 *     max_total: 6             # live forks on this host
 *     max_per_origin: 3
 *     min_free_mb: 2048        # a fork is refused below this much free disk
 *     refresh_seconds: 30      # how often fork heads/diffs are re-reported
 *     promote:                 # separate, default OFF: pushing a branch and opening a draft PR
 *       enabled: false
 *       draft: true
 *       github: { hosts: [github.com], default_repo: owner/name, gh_path: gh }
 */
import { join } from "node:path";
import { readYaml } from "../../lifecycle/policy.ts";
import { DEFAULT_FORK_LIMITS, type ForkLimits } from "../../orchestration/forks.ts";

export interface ForkSettings {
  enabled: boolean;
  limits: ForkLimits;
  refreshMs: number;
  promote: null | {
    draft: boolean;
    github: { hosts?: string[]; defaultRepo?: string; ghPath?: string };
  };
  notes: string[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

export async function loadForkSettings(agentDir: string): Promise<ForkSettings> {
  const base: ForkSettings = {
    enabled: false,
    limits: { ...DEFAULT_FORK_LIMITS },
    refreshMs: 30_000,
    promote: null,
    notes: [],
  };
  const off = (note: string): ForkSettings => ({ ...base, notes: [`forks off: ${note}`] });
  let raw: unknown;
  try {
    raw = (await readYaml(join(agentDir, "engineering.yaml"))).raw;
  } catch (err) {
    return off(`engineering.yaml unreadable (${(err as Error).message})`);
  }
  const block = isPlain(raw) ? raw.forks : undefined;
  if (block === undefined) return base;
  if (!isPlain(block)) return off("`forks` must be a mapping");
  const unknown = Object.keys(block).filter(
    (k) => !["enabled", "max_total", "max_per_origin", "min_free_mb", "refresh_seconds", "promote"].includes(k),
  );
  if (unknown.length) return off(`unknown keys ${unknown.join(", ")}`);
  if (typeof block.enabled !== "boolean") return off("`forks.enabled` must be true or false");
  const limits = { ...DEFAULT_FORK_LIMITS };
  for (const [key, field, lo, hi] of [
    ["max_total", "maxTotal", 1, 50],
    ["max_per_origin", "maxPerOrigin", 1, 10],
    ["min_free_mb", "minFreeMb", 0, 10_000_000],
  ] as const) {
    if (block[key] === undefined) continue;
    const v = int(block[key], lo, hi);
    if (v === null) return off(`\`forks.${key}\` must be an integer ${lo}-${hi}`);
    limits[field] = v;
  }
  let refreshMs = base.refreshMs;
  if (block.refresh_seconds !== undefined) {
    const v = int(block.refresh_seconds, 5, 3600);
    if (v === null) return off("`forks.refresh_seconds` must be an integer 5-3600");
    refreshMs = v * 1000;
  }
  let promote: ForkSettings["promote"] = null;
  if (block.promote !== undefined) {
    const p = block.promote;
    if (!isPlain(p)) return off("`forks.promote` must be a mapping");
    const pu = Object.keys(p).filter((k) => !["enabled", "draft", "github"].includes(k));
    if (pu.length) return off(`unknown keys forks.promote.${pu.join(", ")}`);
    if (typeof p.enabled !== "boolean") return off("`forks.promote.enabled` must be true or false");
    if (p.draft !== undefined && typeof p.draft !== "boolean")
      return off("`forks.promote.draft` must be true or false");
    const gh = p.github;
    const github: { hosts?: string[]; defaultRepo?: string; ghPath?: string } = {};
    if (gh !== undefined) {
      if (!isPlain(gh)) return off("`forks.promote.github` must be a mapping");
      const gu = Object.keys(gh).filter((k) => !["hosts", "default_repo", "gh_path"].includes(k));
      if (gu.length) return off(`unknown keys forks.promote.github.${gu.join(", ")}`);
      if (gh.hosts !== undefined) {
        if (
          !Array.isArray(gh.hosts) ||
          !gh.hosts.every((h) => typeof h === "string" && /^[A-Za-z0-9.\-]{1,100}$/.test(h))
        )
          return off("`forks.promote.github.hosts` must be a list of host names");
        github.hosts = gh.hosts as string[];
      }
      if (gh.default_repo !== undefined) {
        if (typeof gh.default_repo !== "string" || !/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(gh.default_repo))
          return off("`forks.promote.github.default_repo` must look like owner/name");
        github.defaultRepo = gh.default_repo;
      }
      if (gh.gh_path !== undefined) {
        if (typeof gh.gh_path !== "string" || !gh.gh_path || gh.gh_path.startsWith("-"))
          return off("`forks.promote.github.gh_path` must be a command or path");
        github.ghPath = gh.gh_path;
      }
    }
    if (p.enabled) promote = { draft: p.draft !== false, github };
  }
  return { enabled: block.enabled, limits, refreshMs, promote: block.enabled ? promote : null, notes: [] };
}
