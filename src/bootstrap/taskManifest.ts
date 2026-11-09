/** B01 microtask manifest schema: parse + validate only (no runtime integration, no I/O, no deps); see tasks/02-B01.md. */
export const TASK_MANIFEST_FIELDS = [
  "taskId",
  "baseSha",
  "repoId",
  "objective",
  "allowPaths",
  "denyPaths",
  "commands",
  "limits",
  "parentHandoffHash",
  "expectedOutputs",
  "mode",
] as const;
export const TASK_MANIFEST_MODES = ["read-only", "isolated-change", "herdr-ui"] as const;
export type TaskManifestMode = (typeof TASK_MANIFEST_MODES)[number];
export const MICROTASK_CEILING = { maxProductionFiles: 2, maxTestFiles: 2, maxChangedLines: 100 }; // bootstrap hard ceiling: the file caps apply to every mode
// 03-TEST-AND-RELEASE-GATES.md rule 3: "<=2 production files, <=2 tests, target <=100 changed lines (Herdr UI <=120)".
export const MODE_LINE_CEILINGS: Record<TaskManifestMode, number> = {
  "read-only": 100,
  "isolated-change": 100,
  "herdr-ui": 120,
};
export const DEFAULT_LIMITS = { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 100 };
const OPTIONAL_FIELDS = ["limits", "denyPaths", "expectedOutputs"] as const; // absent -> defaults
const LIMIT_FIELDS = ["maxProductionFiles", "maxTestFiles", "maxChangedLines"] as const;
export interface TaskManifestLimits {
  maxProductionFiles: number;
  maxTestFiles: number;
  maxChangedLines: number;
}
export interface TaskManifestCommand {
  argv: string[];
  cwd: string;
}
export interface TaskManifest {
  taskId: string;
  baseSha: string;
  repoId: string;
  objective: string;
  allowPaths: string[];
  denyPaths: string[];
  commands: TaskManifestCommand[];
  limits: TaskManifestLimits;
  parentHandoffHash: string | null;
  expectedOutputs: string[];
  mode: TaskManifestMode;
}
export type TaskManifestParseResult = { ok: true; manifest: TaskManifest } | { ok: false; errors: string[] };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const paths = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((p) => typeof p === "string" && p.trim() !== "") ? (v as string[]) : undefined;
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
/** Valid input (e.g. JSON.parse output) -> { ok: true, manifest } with defaults applied; else deduplicated, sorted errors. */
export function parseTaskManifest(input: unknown): TaskManifestParseResult {
  if (!isRecord(input)) return { ok: false, errors: ["manifest: expected a JSON object"] };
  const errors: string[] = [];
  const bad = (field: string, reason: string) => errors.push(`${field}: ${reason}`);
  const m: Partial<TaskManifest> = {};
  for (const key of Object.keys(input)
    .filter((k) => !(TASK_MANIFEST_FIELDS as readonly string[]).includes(k))
    .sort())
    errors.push(`unknown field: ${key}`);
  for (const field of TASK_MANIFEST_FIELDS)
    if (!(OPTIONAL_FIELDS as readonly string[]).includes(field) && input[field] === undefined)
      errors.push(`${field}: missing`);
  for (const field of ["taskId", "baseSha", "repoId", "objective"] as const) {
    const value = text(input[field]);
    if (value === undefined) bad(field, "expected a non-empty string");
    else if (field === "baseSha" && !/^[0-9a-f]{7,64}$/.test(value)) bad(field, "expected 7-64 hex characters");
    else m[field] = value;
  }
  const allow = paths(input.allowPaths);
  if (allow === undefined) bad("allowPaths", "expected an array of non-empty paths");
  else if (allow.length === 0) bad("allowPaths", "scope must name at least one path");
  else m.allowPaths = allow;
  if (input.denyPaths !== undefined) {
    const deny = paths(input.denyPaths);
    if (deny === undefined) bad("denyPaths", "expected an array of paths");
    else m.denyPaths = deny;
  }
  const commands = input.commands;
  if (!Array.isArray(commands) || commands.length === 0) bad("commands", "expected a non-empty array");
  else
    m.commands = commands.map((command: unknown, index: number) => {
      if (!isRecord(command)) {
        bad(`commands[${index}]`, "expected an object");
        return { argv: [], cwd: "" };
      }
      const argv = paths(command.argv);
      const cwd = text(command.cwd);
      if (argv === undefined || argv.length === 0) bad(`commands[${index}].argv`, "expected a non-empty argv array");
      if (cwd === undefined) bad(`commands[${index}].cwd`, "expected a non-empty string");
      return { argv: argv ?? [], cwd: cwd ?? "" };
    });
  const mode = text(input.mode); // parsed before limits: the line ceiling is mode-aware (spec rule 3)
  if (mode === undefined || !(TASK_MANIFEST_MODES as readonly string[]).includes(mode))
    bad("mode", `expected one of ${TASK_MANIFEST_MODES.join(", ")}`);
  else m.mode = mode as TaskManifestMode;
  const knownMode = m.mode; // undefined when mode is invalid, which is reported by its own error
  const lineCeiling = knownMode === undefined ? MICROTASK_CEILING.maxChangedLines : MODE_LINE_CEILINGS[knownMode];
  const limits = input.limits ?? DEFAULT_LIMITS;
  if (!isRecord(limits)) bad("limits", "expected an object");
  else {
    const parsed: Partial<TaskManifestLimits> = {};
    for (const key of LIMIT_FIELDS) {
      const value = count(limits[key]);
      const ceiling = key === "maxChangedLines" ? lineCeiling : MICROTASK_CEILING[key];
      const named = key === "maxChangedLines" && knownMode !== undefined ? ` for mode ${knownMode}` : "";
      if (value === undefined) bad(`limits.${key}`, "expected a non-negative integer");
      else if (value > ceiling) bad(`limits.${key}`, `${value} exceeds bootstrap ceiling ${ceiling}${named}`);
      else parsed[key] = value;
    }
    for (const key of Object.keys(limits)
      .filter((k) => !(LIMIT_FIELDS as readonly string[]).includes(k))
      .sort())
      errors.push(`unknown field: limits.${key}`);
    if (Object.keys(parsed).length === LIMIT_FIELDS.length) m.limits = parsed as TaskManifestLimits;
  }
  const parent = input.parentHandoffHash;
  if (parent === null) m.parentHandoffHash = null;
  else if (typeof parent === "string" && /^sha256:[0-9a-f]{64}$/.test(parent)) m.parentHandoffHash = parent;
  else bad("parentHandoffHash", "expected null or sha256:<64 hex>");
  if (input.expectedOutputs !== undefined) {
    const out = paths(input.expectedOutputs);
    if (out === undefined) bad("expectedOutputs", "expected an array of paths");
    else m.expectedOutputs = out;
  }
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)].sort() };
  return { ok: true, manifest: { denyPaths: [], expectedOutputs: [], ...m } as TaskManifest }; // no errors -> the partial is complete
}
