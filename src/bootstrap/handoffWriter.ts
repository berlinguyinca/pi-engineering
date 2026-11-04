/**
 * FIX-3B: validate a handoff record against the protocol schema, in the writer, before it is stamped.
 * `validateHandoffSchema` is pure and total: it interprets the subset `templates/handoff.schema.json` actually
 * uses — `type` (object/array/string/number/integer/boolean, unions and their `null` member), `required`,
 * `properties`, `items`, `enum`, `const` (which that schema uses for `specVersion`), `additionalProperties:
 * false` — names the JSON pointer-like path of every blocker (`$.commands[0].exitCode`), and reports a blocker
 * instead of throwing on hostile input. `handoffHash` is exempt at the TOP level only, and only for the two
 * rules the writer's own stamping breaks: it is not required, and it is never an "additional property". It is
 * still type-checked when present. Nothing else is exempt.
 */

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const lit = (value: unknown): string => JSON.stringify(value) ?? String(value);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = { null: (v) => v === null, string: (v) => typeof v === "string", boolean: (v) => typeof v === "boolean", number: (v) => typeof v === "number", integer: (v) => typeof v === "number" && Number.isInteger(v), array: (v) => Array.isArray(v), object: isObject };
/** A `type` keyword outside this table constrains nothing: we invent no semantics the schema does not state. */
const matchesType = (type: unknown, value: unknown): boolean => { const check = typeof type === "string" ? TYPE_CHECKS[type] : undefined; return check === undefined || check(value); };

/** Recursive descent over `properties`/`items`; `top` is what enables the single `handoffHash` exemption. */
function walk(value: unknown, schema: unknown, path: string, top: boolean, blockers: string[]): void {
  if (!isObject(schema)) { blockers.push(`${path}: schema is not an object: ${lit(schema)}`); return; }
  const properties = isObject(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) blockers.push(`${path}: ${lit(value)} is not one of enum ${lit(schema.enum)}`);
  if ("const" in schema && !sameJson(schema.const, value)) blockers.push(`${path}: ${lit(value)} != const ${lit(schema.const)}`);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) blockers.push(`${path}: ${lit(value)} does not match type ${lit(schema.type)}`);
  if (isObject(value)) {
    if (Array.isArray(schema.required)) for (const key of schema.required) {
      if (typeof key !== "string") blockers.push(`${path}.${lit(key)}: schema required entry is not a string`);
      else if (!(top && key === "handoffHash") && !(key in value)) blockers.push(`${path}.${key}: required property missing`);
    }
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(top && key === "handoffHash") && !(key in properties)) blockers.push(`${path}.${key}: disallowed additional property`);
    for (const [key, sub] of Object.entries(properties)) if (key in value) walk(value[key], sub, `${path}.${key}`, false, blockers);
  } else if (Array.isArray(schema.required) || schema.additionalProperties !== undefined || Object.keys(properties).length > 0) blockers.push(`${path}: object required by schema, got ${lit(value)}`);
  if (!Array.isArray(value)) { if (schema.items !== undefined) blockers.push(`${path}: items declared but value is ${lit(value)}, not an array`); return; }
  if (schema.items === undefined) return;
  if (!isObject(schema.items)) { blockers.push(`${path}.items: schema is not an object: ${lit(schema.items)}`); return; }
  value.forEach((element, index) => walk(element, schema.items, `${path}[${index}]`, false, blockers));
}

/** Blockers for `record` against `schema`; `[]` means it conforms. Pure, never throws — hostile input is a blocker. */
export function validateHandoffSchema(record: Record<string, unknown>, schema: unknown): string[] {
  const blockers: string[] = []; walk(record, schema, "$", true, blockers); return blockers;
}
