// D02: one cross-session key per root cause — equivalent occurrences correlate across host/session/run/timestamp/uuid/duration/byte-count/worktree-path/prompt-digest variation, while a 404 never merges with a 429 or with any other cause.
import assert from "node:assert/strict"; import { test } from "node:test";
import { ERROR_OCCURRENCE_VERSION, type ErrorOccurrence } from "../../src/incidents/errorEvent.ts";
import { errorFingerprint, fingerprintInput, INVALID_FINGERPRINT } from "../../src/incidents/errorFingerprint.ts";
const occ = (over: Partial<ErrorOccurrence> = {}): ErrorOccurrence => ({ version: ERROR_OCCURRENCE_VERSION, timestamp: "2026-11-01T00:00:00Z", host: "host-a", sessionId: "sess-a", runtime: "pi@aaa1111", layer: "gateway", code: "gateway.429.rate_limited", severity: "warning", summary: "upstream rate limit: http 429", runId: null, taskId: null, model: null, quantization: null, correlationIds: ["mission-d02"], artifactRefs: [], ...over });
const fp = (over: Partial<ErrorOccurrence> = {}): string => errorFingerprint(occ(over));
const VOLATILE = ["20261104", "aaaabbbbccccdddd", "0011223344556677", "9999a888", "/Users", "pi-a-20261103"]; // long enough that a 16-hex digest cannot contain one by chance
test("equivalent occurrences from another session, host, run, timestamp, uuid, duration, byte count, worktree path and prompt digest share one key (criterion 1)", () => {
  const a = occ({ summary: "upstream rate limit: http 429 in /Users/x/IdeaProjects/worktrees/pi-a-20261103/src/f.ts after 123ms, 4096 bytes, 9 lines <redacted-prompt len=91 sha256=aaaabbbbccccddddeeeeffff00001111>", model: "llama-70b", quantization: "q4_0" });
  const b = occ({ timestamp: "2026-11-05T23:59:59.123456Z", host: "host-b.example.edu", sessionId: "sess-9999a888-7777-6666-5555-444433332222", runId: "run-0011223344556677", taskId: "task-ffee001122334455", correlationIds: ["mission-d99", "evt-2"], artifactRefs: ["logs/b.jsonl"], runtime: "pi@bbb2222", model: "llama-8b", quantization: "q8_0", severity: "error", summary: "upstream rate limit: http 429 in /Users/y/IdeaProjects/worktrees/pi-b-20261104/src/f.ts after 2.5s, 512 bytes, 11 lines <redacted-prompt len=402 sha256=00112233445566778899aabbccddeeff>" });
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), "the two records differ in every volatile field");
  assert.equal(errorFingerprint(a), errorFingerprint(b), "and the key is identical");
  assert.deepEqual(fingerprintInput(occ({ code: "tool.rg.timeout", summary: "tool=rg died in /wt/worktrees/pi-a-20261103/r.ts after 3 attempts" })), { code: "tool.rg.timeout", layer: "gateway", summary: "tool=rg died in <path> after <n>", tool: "rg" }, "what is compared, with paths and counts folded");
});
test("distinct causes stay separate — 404 vs 429 above all, plus layer, tool, root-cause noun and exception class (criterion 2)", () => {
  const pairs: Array<[Partial<ErrorOccurrence>, Partial<ErrorOccurrence>]> = [
    [{ code: "gateway.404.not_found" }, { code: "gateway.429.rate_limited" }], // identical summary and severity: only the dotted code separates them, so code digits survive folding
    [{ layer: "host" }, { layer: "gateway" }],
    [{ code: "tool.rg.timeout" }, { code: "tool.fgrep.timeout" }], // the tool named by the code
    [{ code: "execution.timeout", summary: "tool=rg reset" }, { code: "execution.timeout", summary: "tool=fgrep reset" }], // the tool named by the summary
    [{ summary: "network connection failed: connection reset by peer" }, { summary: "network connection failed: connection timeout" }],
    [{ summary: "TypeError: x is not a function" }, { summary: "RangeError: x is not a function" }],
  ];
  for (const [left, right] of pairs) assert.notEqual(fp(left), fp(right), `these root causes must not merge: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
});
test("deterministic and idempotent, with a fixed digest shape that carries none of the volatile text (criterion 3)", () => {
  const src = { timestamp: "2026-11-04T10:00:00Z", host: "h", sessionId: "sess-9999a888-7777-6666-5555-444433332222", runId: "run-0011223344556677", summary: "upstream rate limit: http 429 sha=aaaabbbbccccddddeeeeffff00001111 in /Users/x/IdeaProjects/worktrees/pi-a-20261103/src/f.ts" };
  const first = fp(src);
  assert.equal(errorFingerprint(occ(src)), first); assert.equal(fp(src), first); assert.equal(fp({ ...src }), first); // repeated calls, a copy, and a later call in this same process
  assert.match(first, /^[0-9a-f]{16}$/, "always sixteen lowercase hex characters");
  for (const leak of VOLATILE) assert.ok(!first.includes(leak), `${leak} leaked into the key`);
});
test("malformed input is total: the documented fallback key or a documented coercion, never a throw (criterion 4)", () => {
  for (const bad of [null, undefined, 42, "nope", {}, [], { code: "", summary: "" }]) assert.equal(errorFingerprint(bad as never), INVALID_FINGERPRINT, "nothing attributable is one stable key, derived from no raw text at all");
  assert.equal(fp({ code: 7 as never, summary: null as never }), fp({ code: "7", summary: "" }), "a non-string scalar coerces the same way every time instead of throwing");
  const hostile = { ...occ(), get summary(): string { throw new Error("boom"); } }; assert.equal(errorFingerprint(hostile), fp({ summary: "" }), "a throwing getter is no evidence, and no crash");
});
test("the key is not the payload digest: pointers, severity and model alone cannot move it (criterion 5)", () => {
  const pointers = { sessionId: "sess-z", timestamp: "2030-01-01T00:00:00Z", host: "elsewhere", runtime: "pi@zzz9999", runId: "run-zzz", taskId: "task-zzz", correlationIds: ["x", "y"], artifactRefs: ["logs/z.jsonl"] };
  assert.notEqual(JSON.stringify(occ()), JSON.stringify(occ(pointers)), "the payload changed");
  assert.equal(fp(pointers), fp(), "the key did not, so it digests the discriminators and not the record");
  assert.equal(fp({ severity: "fatal" }), fp()); assert.equal(fp({ model: "llama-70b", quantization: "q4_0" }), fp(), "loudness and model are dropped: they would split equivalent errors");
});
