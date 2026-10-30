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
import { sameModel } from "./host/quotaResume.ts";

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

// ── validation ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface QuotaFallbackValidation {
  /** The config to use: the strictly parsed block when it is valid, EMPTY (fail-closed: no switching) otherwise. */
  config: QuotaFallbackConfig;
  /** Fail-closed problems: wrong shape, non-string entries, duplicates, unknown ids, a list of only the pinned model. */
  errors: string[];
  /** Loud but non-fatal: unverifiable ids, empty lists, a list that names the role's own model among others. */
  warnings: string[];
}

export interface QuotaFallbackValidationContext {
  /**
   * The model registry, or null/empty when it could not be read. Without it ids cannot be checked, which is a warning,
   * never an error (a slow registry must not make a valid config look broken).
   */
  registry?: ReadonlyArray<{ provider: string; id: string }> | null;
  /** role -> its pinned model (`routing.roles.<role>.model`), for the "only the pinned model" check. */
  rolePins?: Readonly<Record<string, string | undefined>>;
}

/**
 * Strict validation of the `quota_fallbacks` block. Ids resolve exactly the way the runtime resolves them
 * (continuityWiring): plain `id` or `provider/id`. Unlike parseQuotaFallbackConfig (which drops what it cannot read),
 * ANY error here makes the whole block unusable: a half-trusted fallback list is a silent wrong-model switch.
 * A missing block is valid and means "no fallback configured".
 */
export function validateQuotaFallbacks(
  raw: unknown,
  ctx: QuotaFallbackValidationContext = {},
): QuotaFallbackValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): QuotaFallbackValidation => ({ config: EMPTY_QUOTA_FALLBACK_CONFIG, errors, warnings });
  if (raw === undefined || raw === null) return { config: EMPTY_QUOTA_FALLBACK_CONFIG, errors, warnings };
  if (!isPlain(raw)) {
    errors.push("quota_fallbacks must be a mapping with `roles:` and/or `default:`");
    return fail();
  }
  for (const key of Object.keys(raw)) {
    if (key !== "roles" && key !== "default") {
      errors.push(`quota_fallbacks.${key}: unknown key (expected only \`roles\` and \`default\`)`);
    }
  }
  const registry = ctx.registry && ctx.registry.length > 0 ? ctx.registry : null;
  if (!registry) {
    warnings.push("model registry unavailable: quota_fallbacks ids were not checked against it");
  }
  const resolves = (id: string): boolean =>
    registry?.some((m) => m.id === id || `${m.provider}/${m.id}` === id) === true;

  const check = (value: unknown, label: string, pin: string | undefined): string[] => {
    if (!Array.isArray(value)) {
      errors.push(`${label}: expected a list of model ids`);
      return [];
    }
    const out: string[] = [];
    value.forEach((entry, i) => {
      if (typeof entry !== "string" || entry.trim() === "") {
        errors.push(`${label}[${i}]: expected a non-empty string model id, got ${JSON.stringify(entry)}`);
        return;
      }
      const id = entry.trim();
      if (out.includes(id)) errors.push(`${label}: duplicate model id ${id}`);
      else out.push(id);
      if (registry && !resolves(id)) {
        errors.push(
          `${label}: ${id} is not in the model registry (use \`provider/id\` or the plain id as the registry lists it)`,
        );
      }
    });
    if (value.length === 0) {
      warnings.push(
        `${label}: empty list (a role with an empty list uses \`default\`; with no default, handoff blocks)`,
      );
    }
    if (pin && out.length > 0) {
      if (out.every((id) => sameModel(id, pin))) {
        errors.push(`${label}: lists only the role's own pinned model ${pin}; a fallback must be a different model`);
      } else if (out.some((id) => sameModel(id, pin))) {
        warnings.push(
          `${label}: includes the role's own pinned model ${pin}; it is skipped when that model is the exhausted one`,
        );
      }
    }
    return out;
  };

  const roles: Record<string, string[]> = {};
  if (raw.roles !== undefined) {
    if (!isPlain(raw.roles)) errors.push("quota_fallbacks.roles: expected a mapping of role -> list of model ids");
    else {
      for (const [role, models] of Object.entries(raw.roles)) {
        const parsed = check(models, `quota_fallbacks.roles.${role}`, ctx.rolePins?.[role]);
        if (parsed.length > 0) roles[role] = parsed;
      }
    }
  }
  const dflt = raw.default === undefined ? [] : check(raw.default, "quota_fallbacks.default", undefined);
  if (Object.keys(roles).length === 0 && dflt.length === 0 && errors.length === 0) {
    warnings.push("quota_fallbacks is set but lists no models: a quota-exhausted run will block with a reason");
  }
  if (errors.length > 0) return fail();
  return { config: { roles, default: dflt }, errors, warnings };
}

/** Load and validate `<agentDir>/engineering.yaml`; an unreadable file is an error (the operator wrote something). */
export async function loadValidatedQuotaFallbacks(
  agentDir: string,
  ctx: QuotaFallbackValidationContext = {},
): Promise<QuotaFallbackValidation> {
  try {
    const { raw } = await readYaml(join(agentDir, "engineering.yaml"));
    return validateQuotaFallbacks(isPlain(raw) ? raw.quota_fallbacks : undefined, ctx);
  } catch (err) {
    return {
      config: EMPTY_QUOTA_FALLBACK_CONFIG,
      errors: [`quota_fallbacks: engineering.yaml unreadable (${(err as Error).message})`],
      warnings: [],
    };
  }
}
