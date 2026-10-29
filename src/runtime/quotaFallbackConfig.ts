/**
 * Quota fallback models, from the GLOBAL engineering.yaml (YAML only, no environment variables):
 *
 *   quota_fallbacks:
 *     roles:
 *       implementer: [provider/model-b, provider/model-c]   # ordered: first eligible one wins
 *     default: [provider/model-z]                           # used for roles without their own list
 *
 * A quota-exhausted run may switch ONLY to a model named here. An empty or missing list means "no fallback
 * configured": the handoff then says so and stays blocked; a model is never picked from the registry on the
 * operator's behalf.
 */
import { join } from "node:path";
import { readYaml } from "../lifecycle/policy.ts";

export interface QuotaFallbackConfig {
  roles: Record<string, string[]>;
  default: string[];
}

export const EMPTY_QUOTA_FALLBACK_CONFIG: QuotaFallbackConfig = { roles: {}, default: [] };

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function list(value: unknown, label: string, notes: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    notes.push(`quota_fallbacks ${label} ignored: expected a list of model ids`);
    return [];
  }
  return [...new Set((value as string[]).map((v) => v.trim()))];
}

export function parseQuotaFallbackConfig(raw: unknown): { config: QuotaFallbackConfig; notes: string[] } {
  const notes: string[] = [];
  if (raw === undefined || raw === null) return { config: EMPTY_QUOTA_FALLBACK_CONFIG, notes };
  if (!isPlain(raw)) return { config: EMPTY_QUOTA_FALLBACK_CONFIG, notes: ["quota_fallbacks ignored: not a mapping"] };
  const roles: Record<string, string[]> = {};
  if (isPlain(raw.roles)) {
    for (const [role, models] of Object.entries(raw.roles)) {
      const parsed = list(models, `role ${role}`, notes);
      if (parsed.length > 0) roles[role] = parsed;
    }
  } else if (raw.roles !== undefined) {
    notes.push("quota_fallbacks roles ignored: not a mapping");
  }
  return { config: { roles, default: list(raw.default, "default", notes) }, notes };
}

/** The ordered fallbacks for a role: its own list, else the default list, else empty (= none configured). */
export function quotaFallbacksFor(config: QuotaFallbackConfig, role: string | null | undefined): string[] {
  const own = role ? config.roles[role] : undefined;
  return own && own.length > 0 ? own : config.default;
}

/** Read the block from `<agentDir>/engineering.yaml`. Never throws: unreadable = no fallbacks plus a note. */
export async function loadQuotaFallbackConfig(
  agentDir: string,
): Promise<{ config: QuotaFallbackConfig; notes: string[] }> {
  try {
    const { raw } = await readYaml(join(agentDir, "engineering.yaml"));
    return parseQuotaFallbackConfig(isPlain(raw) ? raw.quota_fallbacks : undefined);
  } catch (err) {
    return {
      config: EMPTY_QUOTA_FALLBACK_CONFIG,
      notes: [`quota_fallbacks: engineering.yaml unreadable (${(err as Error).message})`],
    };
  }
}
