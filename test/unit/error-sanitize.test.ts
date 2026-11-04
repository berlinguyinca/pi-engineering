// E04: none of the secret fixtures below may appear in the persisted representation, and what replaces them must still be a valid E02 occurrence.
import assert from "node:assert/strict"; import test, { after } from "node:test";
import { MAX_ARTIFACT_REFS, MAX_CORRELATION_IDS, MAX_PERSISTED_BYTES, SUMMARY_MAX_CHARS, sanitizeForPersistence } from "../../src/incidents/errorSanitize.ts";
import { ERROR_OCCURRENCE_VERSION, parseErrorOccurrence, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts";
import { normalizeError, UNATTRIBUTED, type NormalizationContext } from "../../src/incidents/errorNormalize.ts";
const ENV = "E04_TEST_SECRET_KEY"; const ENV_VALUE = "zq7Kx9V2-env-value-never-real"; process.env[ENV] = ENV_VALUE; after(() => { delete process.env[ENV]; }); // the one env entry this file mutates, and its restore
const SK = "sk-proj-YWJjZGVmZ2hpamtsbW5vcA"; const TOKEN = "c2VjcmV0dG9rZW4udG9rZW4"; const AWS = "AKIA1234567890ABCDEF"; const PEM_BODY = "MIIEowIBAAKCAQEA0Z3Baseline";
const PEM = `-----BEGIN RSA PRIVATE KEY----- ${PEM_BODY} -----END RSA PRIVATE KEY-----`; const ABS = "/Users/wohlgemuth/private/agent.log"; const REL = "logs/run-42.jsonl";
const FIXTURES = [SK, TOKEN, AWS, PEM_BODY, ENV_VALUE, ABS]; const PROMPT = `system: ${"a very long raw prompt transcript that must never reach the error index ".repeat(20)}`; // OpenAI-style key, Bearer token, AWS id, PEM key body, env value, absolute path, raw prompt
const DIRTY: Record<string, unknown> = { version: ERROR_OCCURRENCE_VERSION, timestamp: "2026-11-04T09:00:00.000Z", host: "workstation", sessionId: "sess-e04", runtime: `pi-engineering@${AWS}`,
  layer: "gateway", code: "gateway.400.bad_request", severity: "error", runId: null, taskId: "E04", model: PEM, quantization: null, secret_field: "never persisted",
  summary: `upstream refused: key=${SK} Authorization: Bearer ${TOKEN} env=${ENV_VALUE} while reading ${ABS}`, correlationIds: ["mission-msn-e04", `exec-${ENV_VALUE}`], artifactRefs: [REL, ABS, "../escape", "a b.txt"] };
const CTX: NormalizationContext = { timestamp: "2026-11-04T09:00:00Z", host: "workstation", sessionId: "sess-e04", runtime: "pi-engineering@abc", correlationIds: ["mission-msn-e04"], artifactRefs: [REL] };

test("every secret fixture is absent from the persisted representation and only the env variable's name survives", () => {
  const out = sanitizeForPersistence(DIRTY); assert.ok(out !== null); const json = JSON.stringify(out); // sk-, Bearer token, AKIA, PEM body, env value, absolute path
  for (const fixture of FIXTURES) assert.ok(!json.includes(fixture), `leaked: ${fixture}`);
  assert.ok(json.includes(ENV) && json.includes("[env:") && !json.includes(ENV_VALUE) && json.includes("<path>") && !json.includes("/Users/"), json);
  assert.deepEqual(out.artifactRefs, [REL]); assert.deepEqual(out.correlationIds, ["mission-msn-e04", "exec-[env:E04_TEST_SECRET_KEY]"]); assert.ok(!json.includes("secret_field"), json);
  assert.equal(parseErrorOccurrence(out).ok, true, json); });

test("a raw prompt becomes its length plus a stable digest, never a shorter prefix of itself", () => {
  const build = (): ErrorOccurrence | null => sanitizeForPersistence({ ...DIRTY, summary: PROMPT }); const once = build(); assert.ok(once !== null);
  const m = /<redacted-prompt len=(\d+) sha256=([0-9a-f]{32})>/.exec(once.summary); assert.ok(m, once.summary); assert.equal(Number(m[1]) > SUMMARY_MAX_CHARS, true, once.summary);
  assert.deepEqual(build(), once); assert.ok(once.summary.length < PROMPT.length / 5 && !once.summary.includes("transcript"), once.summary); // the digest is stable across two runs
  assert.match(sanitizeForPersistence({ ...DIRTY, summary: "user: run the tests" })?.summary ?? "", /^<redacted-prompt /); }); // short, but transcript-shaped

test("list caps drop the tail into a counted marker instead of silently, and re-sanitizing does not stack it", () => {
  const wide = sanitizeForPersistence({ ...DIRTY, artifactRefs: Array.from({ length: 40 }, (_, i) => `logs/run-${i}.jsonl`), correlationIds: Array.from({ length: 40 }, (_, i) => `exec-${i}`) });
  assert.ok(wide !== null); assert.deepEqual(wide.artifactRefs, Array.from({ length: MAX_ARTIFACT_REFS }, (_, i) => `logs/run-${i}.jsonl`)); assert.equal(wide.correlationIds.length, MAX_CORRELATION_IDS);
  assert.match(wide.summary, / \[refs\+32 dropped\] \[ids\+32 dropped\]$/); assert.deepEqual(sanitizeForPersistence(wide), wide); // relative evidence survives; only the count is capped
  assert.deepEqual(sanitizeForPersistence({ ...DIRTY, correlationIds: [] })?.correlationIds, [UNATTRIBUTED]); assert.deepEqual(sanitizeForPersistence({ ...DIRTY, artifactRefs: [] })?.artifactRefs, []); });

test("the persisted record respects the byte budget, however oversized the occurrence", () => {
  const oversized = { ...DIRTY, model: "q".repeat(5000), artifactRefs: Array.from({ length: 40 }, (_, i) => `logs/${"d".repeat(90)}-${i}.jsonl`), correlationIds: Array.from({ length: 40 }, (_, i) => `id-${"e".repeat(90)}-${i}`) };
  const big = sanitizeForPersistence(oversized); assert.ok(big !== null); assert.ok(Buffer.byteLength(JSON.stringify(big)) <= MAX_PERSISTED_BYTES, String(Buffer.byteLength(JSON.stringify(big))));
  assert.deepEqual(sanitizeForPersistence(big), big); assert.equal(parseErrorOccurrence(big).ok, true, JSON.stringify(big)); const tight = sanitizeForPersistence(oversized, { maxPersistedBytes: 512 }); // idempotent even at the cap; a policy only ever shrinks
  assert.ok(tight !== null && Buffer.byteLength(JSON.stringify(tight)) <= 512 && parseErrorOccurrence(tight).ok); });

test("sanitize is idempotent, keeps the evidence E03 carried, and never throws on malformed input", () => {
  for (const input of [DIRTY, { ...DIRTY, summary: PROMPT }, { ...DIRTY, timestamp: "yesterday", layer: "nonsense", severity: "loud", host: "" }]) {
    const once = sanitizeForPersistence(input); assert.ok(once !== null); assert.equal(parseErrorOccurrence(once).ok, true, JSON.stringify(once)); assert.deepEqual(sanitizeForPersistence(once), once); }
  const fromE03 = sanitizeForPersistence(normalizeError({ httpStatus: 429, message: `rate limited key=${SK} at ${ABS}`, evidenceRef: REL }, CTX)); assert.ok(fromE03 !== null && !JSON.stringify(fromE03).includes(SK) && fromE03.artifactRefs.includes(REL) && parseErrorOccurrence(fromE03).ok); // the E03 -> E04 pipeline
  const hostile = { get message(): string { throw new Error("hostile getter"); }, get correlationIds(): string[] { throw new Error("hostile getter"); } };
  for (const junk of [null, undefined, 42, "boom", true, [1, 2], new Error("raw"), hostile]) assert.doesNotThrow(() => sanitizeForPersistence(junk), String(junk === hostile ? "hostile" : junk));
  const refused = sanitizeForPersistence(hostile); assert.ok(refused !== null && refused.sessionId === UNATTRIBUTED && parseErrorOccurrence(refused).ok); });

test("a clean occurrence passes through unchanged apart from the caps", () => {
  const clean: ErrorOccurrence = { version: ERROR_OCCURRENCE_VERSION, timestamp: "2026-11-04T09:00:00Z", host: "workstation", sessionId: "sess-e04", runtime: "pi-engineering@abc", layer: "verify",
    code: "verify.failed", severity: "error", summary: "make verify exited with status 2", runId: "run-42", taskId: "E04", model: "metabolomics/qwen3.8-flash_next", quantization: null, correlationIds: ["mission-msn-e04"], artifactRefs: [REL] };
  assert.deepEqual(sanitizeForPersistence(clean), clean); assert.deepEqual(sanitizeForPersistence({ ...clean, summary: "user: fix the build" })?.artifactRefs, [REL]); }); // transcript digested, evidence kept
