/**
 * The global `engineering.yaml` `github:` block (no environment variables). A repository file cannot set it.
 *
 *   github:
 *     enabled: true                    # required for any GitHub call (default off)
 *     hosts: [github.com]              # accepted hosts
 *     default_repo: owner/name         # resolves bare #N
 *     gh_path: /usr/bin/gh             # the gh executable
 *     required_checks: [ci]            # checks the merge gate waits for (default: every check on the head)
 *     rereview_command: [/opt/bin/request-review]   # argv; Pi appends --pr <id> --head <sha> --signal <id>
 *
 * Anything malformed or unsafe turns the layer off with a note.
 */
import { join } from "node:path";
import { readYaml } from "../lifecycle/policy.ts";
import type { GithubConfig } from "./client.ts";

export interface GithubSettings {
  config: GithubConfig;
  requiredChecks: string[];
  rereviewCommand: string[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const KEYS = new Set(["enabled", "hosts", "default_repo", "gh_path", "required_checks", "rereview_command"]);
const NAME = /^[A-Za-z0-9._ \-/]{1,100}$/;

export async function loadGithubSettings(
  agentDir: string,
): Promise<{ settings: GithubSettings | null; notes: string[] }> {
  let raw: unknown;
  try {
    raw = (await readYaml(join(agentDir, "engineering.yaml"))).raw;
  } catch (err) {
    return { settings: null, notes: [`github off: engineering.yaml unreadable (${(err as Error).message})`] };
  }
  const block = isPlain(raw) ? raw.github : undefined;
  if (block === undefined) return { settings: null, notes: [] };
  const off = (note: string) => ({ settings: null, notes: [`github off: ${note}`] });
  if (!isPlain(block)) return off("`github` must be a mapping");
  const unknown = Object.keys(block).filter((k) => !KEYS.has(k));
  if (unknown.length) return off(`unknown keys ${unknown.join(", ")}`);
  if (block.enabled !== true) return { settings: null, notes: [] };
  const config: GithubConfig = { enabled: true };
  if (block.hosts !== undefined) {
    if (
      !Array.isArray(block.hosts) ||
      !block.hosts.every((h) => typeof h === "string" && /^[A-Za-z0-9.\-]{1,100}$/.test(h))
    )
      return off("`github.hosts` must be a list of host names");
    config.hosts = block.hosts as string[];
  }
  if (block.default_repo !== undefined) {
    if (typeof block.default_repo !== "string" || !/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(block.default_repo))
      return off("`github.default_repo` must look like owner/name");
    config.defaultRepo = block.default_repo;
  }
  if (block.gh_path !== undefined) {
    if (typeof block.gh_path !== "string" || !block.gh_path || block.gh_path.startsWith("-"))
      return off("`github.gh_path` must be a command or path");
    config.ghPath = block.gh_path;
  }
  let requiredChecks: string[] = [];
  if (block.required_checks !== undefined) {
    if (
      !Array.isArray(block.required_checks) ||
      !block.required_checks.every((c) => typeof c === "string" && NAME.test(c))
    )
      return off("`github.required_checks` must be a list of check names");
    requiredChecks = block.required_checks as string[];
  }
  let rereviewCommand: string[] = [];
  if (block.rereview_command !== undefined) {
    const c = block.rereview_command;
    if (
      !Array.isArray(c) ||
      c.length === 0 ||
      !c.every((a) => typeof a === "string" && a.length > 0 && a.length < 500) ||
      (c[0] as string).startsWith("-")
    )
      return off("`github.rereview_command` must be a non-empty argv list");
    rereviewCommand = c as string[];
  }
  return { settings: { config, requiredChecks, rereviewCommand }, notes: [] };
}
