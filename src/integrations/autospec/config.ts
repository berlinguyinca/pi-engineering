/**
 * `autospec` block of the engineering YAML layers (T04). Everything is OFF unless
 * a layer contains it; there are no environment variables.
 *
 *   ~/.pi/agent/engineering.yaml   global layer: may set everything
 *   <repo>/.pi/engineering.yaml    repo layer: may only TIGHTEN the design gate
 *
 *   autospec:
 *     dag: {enabled: true}                       # allow AutoSpec DAG ingestion (global only)
 *     design_gate:
 *       report: .autospec/reports/design-gates.json   # repo-relative (global only)
 *       rules_file: /path/to/autospec-design/rules.yaml  # Pi's own view of rule classes (global only)
 *       ui_paths: ["src/ui/**"]                  # global sets; repo may ADD
 *       require_for_ui: true                     # global or repo; a repo can only turn it ON
 *     quality_law:                               # global only; informational
 *       profile_file: /path/profile.json
 *       profile_id: web-app
 *       gate_files: [/path/gate.json]
 *
 * Malformed config FAILS CLOSED: `invalid` carries the reason and the design gate
 * becomes a required, unavailable item. Nothing here touches disk; the caller
 * supplies the parsed layers.
 */

export interface AutoSpecConfig {
  dag: { enabled: boolean };
  designGate: null | {
    reportPath: string;
    rulesFile: string | null;
    uiPaths: string[];
    requireForUi: boolean;
  };
  qualityLaw: null | { profileFile: string | null; profileId: string | null; gateFiles: string[] };
  notes: string[];
}

export type AutoSpecConfigResult =
  | { kind: "off" }
  | { kind: "invalid"; notes: string[] }
  | { kind: "on"; config: AutoSpecConfig };

export interface AutoSpecLayer {
  raw?: unknown;
  error?: string;
}

export const DEFAULT_REPORT_PATH = ".autospec/reports/design-gates.json";

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => !!v && typeof v === "object" && !Array.isArray(v);
class Bad extends Error {}

function exact(raw: Plain, keys: string[], where: string): void {
  for (const k of Object.keys(raw)) if (!keys.includes(k)) throw new Bad(`${where}: unknown key "${k}"`);
}
function strList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x))
    throw new Bad(`${where} must be a list of non-empty strings`);
  return v as string[];
}
function relInRepo(v: unknown, where: string): string {
  if (typeof v !== "string" || !v || v.startsWith("/") || v.includes("\\") || v.split("/").includes("..")) {
    throw new Bad(`${where} must be a repo-relative path without ".."`);
  }
  return v;
}
function bool(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new Bad(`${where} must be true or false (a YAML boolean)`);
  return v;
}

interface Block {
  dag?: { enabled: boolean };
  design?: { reportPath?: string; rulesFile?: string; uiPaths?: string[]; requireForUi?: boolean };
  law?: { profileFile?: string; profileId?: string; gateFiles?: string[] };
}

function parseBlock(raw: unknown, where: string, global: boolean, notes: string[]): Block {
  if (!isPlain(raw)) throw new Bad(`${where}: autospec must be a mapping`);
  exact(raw, ["dag", "design_gate", "quality_law"], `${where}: autospec`);
  const out: Block = {};
  if (raw.dag !== undefined) {
    if (!isPlain(raw.dag)) throw new Bad(`${where}: autospec.dag must be a mapping`);
    exact(raw.dag, ["enabled"], `${where}: autospec.dag`);
    const enabled = bool(raw.dag.enabled, `${where}: autospec.dag.enabled`);
    if (global) out.dag = { enabled };
    else notes.push("repo autospec.dag ignored (only the global/user config may enable DAG ingestion)");
  }
  if (raw.design_gate !== undefined) {
    const d = raw.design_gate;
    if (!isPlain(d)) throw new Bad(`${where}: autospec.design_gate must be a mapping`);
    exact(d, ["report", "rules_file", "ui_paths", "require_for_ui"], `${where}: autospec.design_gate`);
    const design: NonNullable<Block["design"]> = {};
    if (d.ui_paths !== undefined) design.uiPaths = strList(d.ui_paths, `${where}: design_gate.ui_paths`);
    if (d.require_for_ui !== undefined) {
      const v = bool(d.require_for_ui, `${where}: design_gate.require_for_ui`);
      if (global || v) design.requireForUi = v;
      else notes.push("repo design_gate.require_for_ui: false ignored (a repo cannot relax the design gate)");
    }
    for (const k of ["report", "rules_file"] as const) {
      if (d[k] === undefined) continue;
      if (!global) notes.push(`repo design_gate.${k} ignored (only the global/user config may set it)`);
      else if (k === "report") design.reportPath = relInRepo(d[k], `${where}: design_gate.report`);
      else if (typeof d[k] !== "string" || !d[k]) throw new Bad(`${where}: design_gate.rules_file must be a string`);
      else design.rulesFile = d[k] as string;
    }
    out.design = design;
  }
  if (raw.quality_law !== undefined) {
    const q = raw.quality_law;
    if (!isPlain(q)) throw new Bad(`${where}: autospec.quality_law must be a mapping`);
    exact(q, ["profile_file", "profile_id", "gate_files"], `${where}: autospec.quality_law`);
    if (!global) notes.push("repo autospec.quality_law ignored (only the global/user config may set it)");
    else {
      const law: NonNullable<Block["law"]> = {};
      if (q.profile_file !== undefined) {
        if (typeof q.profile_file !== "string" || !q.profile_file)
          throw new Bad(`${where}: quality_law.profile_file must be a string`);
        law.profileFile = q.profile_file;
      }
      if (q.profile_id !== undefined) {
        if (typeof q.profile_id !== "string" || !q.profile_id)
          throw new Bad(`${where}: quality_law.profile_id must be a string`);
        law.profileId = q.profile_id;
      }
      if (q.gate_files !== undefined) law.gateFiles = strList(q.gate_files, `${where}: quality_law.gate_files`);
      out.law = law;
    }
  }
  return out;
}

/** Pure merge of the two layers. Absent in both = off. */
export function mergeAutoSpecLayers(layers: { global: AutoSpecLayer; repo: AutoSpecLayer }): AutoSpecConfigResult {
  const notes: string[] = [];
  const errors: string[] = [];
  let g: Block | undefined;
  let r: Block | undefined;
  if (layers.global.error) errors.push(`global config unreadable: ${layers.global.error}`);
  else if (layers.global.raw !== undefined) {
    try {
      g = parseBlock(layers.global.raw, "global", true, notes);
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      errors.push(e.message);
    }
  }
  if (layers.repo.error) {
    // A repo layer cannot loosen anything; an unreadable one that might have tightened is noted.
    notes.push(`repo config unreadable, autospec from it ignored: ${layers.repo.error}`);
  } else if (layers.repo.raw !== undefined) {
    try {
      r = parseBlock(layers.repo.raw, "repo", false, notes);
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      errors.push(e.message);
    }
  }
  const present = layers.global.raw !== undefined || layers.repo.raw !== undefined || !!layers.global.error;
  if (!present) return { kind: "off" };
  if (errors.length) return { kind: "invalid", notes: [...errors, ...notes] };

  const uiPaths = [...new Set([...(g?.design?.uiPaths ?? []), ...(r?.design?.uiPaths ?? [])])];
  const wantsDesign = !!(g?.design || r?.design);
  const requireForUi = !!(g?.design?.requireForUi || r?.design?.requireForUi);
  if (wantsDesign && requireForUi && uiPaths.length === 0) {
    return {
      kind: "invalid",
      notes: ["design_gate.require_for_ui needs a non-empty ui_paths list: Pi must know what is UI", ...notes],
    };
  }
  return {
    kind: "on",
    config: {
      dag: { enabled: g?.dag?.enabled === true },
      designGate: wantsDesign
        ? {
            reportPath: g?.design?.reportPath ?? DEFAULT_REPORT_PATH,
            rulesFile: g?.design?.rulesFile ?? null,
            uiPaths,
            requireForUi,
          }
        : null,
      qualityLaw: g?.law
        ? {
            profileFile: g.law.profileFile ?? null,
            profileId: g.law.profileId ?? null,
            gateFiles: g.law.gateFiles ?? [],
          }
        : null,
      notes,
    },
  };
}
