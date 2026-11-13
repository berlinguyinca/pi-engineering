/**
 * The exported contract of manifest-binding-scan.mjs.
 *
 * The gate is plain JavaScript on purpose -- CI runs it under `node` before `npm install`, so it
 * cannot import TypeScript -- and this file is what lets the TypeScript test that pins it
 * (test/unit/manifest-binding-parser-agreement.test.ts) import it without falling back to `any`.
 * A `any` import would let the test pass while comparing nothing, which is the failure mode the
 * pin exists to prevent.
 */

/** canonicalHash per 02-HANDOFF-PROTOCOL.md:15 and src/bootstrap/resultGate.ts:30: sorted keys at
 * every level, compact JSON, UTF-8, `handoffHash` excluded. Returns `sha256:<64 hex>`. */
export declare function canon(record: Record<string, unknown>): string;

/** The success path of parseTaskManifest (src/bootstrap/taskManifest.ts): known fields only, the
 * three defaults applied, each command reduced to `{argv, cwd}`. Exactly one of the two properties
 * is present -- `manifest` when the input is a manifest the parser would accept, `errors` (deduplicated
 * and sorted, as the parser returns them) when it would not. */
export declare function normalizeManifest(input: unknown): { manifest?: unknown; errors?: string[] };
