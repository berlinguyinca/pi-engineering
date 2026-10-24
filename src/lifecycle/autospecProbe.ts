/**
 * Decides whether the optional AutoSpec integration is CONFIGURED, from the raw
 * engineering.yaml layers, without importing the integration (T04).
 *
 * `loadPolicy` swallows YAML parse errors, so a malformed global file would make
 * `policy.autospec` look absent and silently switch a required design gate off.
 * This probe reads the layers itself: a layer that cannot be read or parsed, or
 * is not a mapping, counts as configured (the integration then reports it as
 * invalid and blocks). Only a layer that is absent or parses to a mapping with
 * no `autospec` key counts as "not configured".
 */
import { join } from "node:path";
import { readYaml } from "./policy.ts";

export async function autospecConfigured(
  cwd: string,
  opts: { agentDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  const agentDir = opts.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  for (const path of [join(agentDir, "engineering.yaml"), join(cwd, ".pi", "engineering.yaml")]) {
    try {
      const { raw } = await readYaml(path);
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== "object" || Array.isArray(raw)) return true;
      if ((raw as Record<string, unknown>).autospec !== undefined) return true;
    } catch {
      return true;
    }
  }
  return false;
}
