/**
 * `vision_delegate:` block of the GLOBAL `engineering.yaml`. YAML only: there is no flag and no environment
 * variable, and a repository file can never change it (only `<agentDir>/engineering.yaml` is read). Anything
 * malformed turns the feature OFF with a note, except an out-of-range `wait_seconds`, which keeps the default.
 *
 *   vision_delegate:
 *     enabled: true                      # default true; false is the kill switch
 *     wait_seconds: 300                  # integer 10-3600
 *     alias_preference: [qwen3.8-vision] # non-empty list of model aliases, in order of preference
 */
import { join } from "node:path";
import { readYaml } from "../lifecycle/policy.ts";

export interface VisionDelegateSettings {
  enabled: boolean;
  waitSeconds: number;
  aliasPreference: string[];
  notes: string[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

export async function loadVisionDelegateSettings(agentDir: string): Promise<VisionDelegateSettings> {
  const base: VisionDelegateSettings = {
    enabled: true,
    waitSeconds: 300,
    aliasPreference: ["qwen3.8-vision"],
    notes: [],
  };
  const off = (note: string): VisionDelegateSettings => ({
    ...base,
    enabled: false,
    aliasPreference: [...base.aliasPreference],
    notes: [`vision_delegate off: ${note}`],
  });
  let raw: unknown;
  try {
    raw = (await readYaml(join(agentDir, "engineering.yaml"))).raw;
  } catch (err) {
    return off(`engineering.yaml unreadable (${(err as Error).message})`);
  }
  const block = isPlain(raw) ? raw.vision_delegate : undefined;
  if (block === undefined) return { ...base, aliasPreference: [...base.aliasPreference] };
  if (!isPlain(block)) return off("`vision_delegate` must be a mapping");
  const unknown = Object.keys(block).filter((k) => !["enabled", "wait_seconds", "alias_preference"].includes(k));
  if (unknown.length) return off(`unknown keys ${unknown.join(", ")}`);
  if (block.enabled !== undefined && typeof block.enabled !== "boolean")
    return off("`vision_delegate.enabled` must be true or false");
  const notes: string[] = [];
  let waitSeconds = base.waitSeconds;
  if (block.wait_seconds !== undefined) {
    const v = int(block.wait_seconds, 10, 3600);
    if (v === null)
      notes.push(`vision_delegate: \`wait_seconds\` must be an integer 10-3600; keeping ${base.waitSeconds}`);
    else waitSeconds = v;
  }
  let aliasPreference = [...base.aliasPreference];
  if (block.alias_preference !== undefined) {
    const a = block.alias_preference;
    if (!Array.isArray(a) || a.length === 0 || !a.every((x) => typeof x === "string" && x.length > 0))
      return off("`vision_delegate.alias_preference` must be a non-empty list of non-empty strings");
    aliasPreference = [...(a as string[])];
  }
  return { enabled: block.enabled !== false, waitSeconds, aliasPreference, notes };
}
