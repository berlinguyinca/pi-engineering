import assert from "node:assert/strict";
import test from "node:test";

import {
  type SavedImage,
  type VisionRequest,
  type VisionResult,
  buildRequestFile,
  parseResult,
  renderHandback,
  resultPath,
} from "../../src/visionDelegation/protocol.ts";

const A: SavedImage = { path: "/s/images/a.png", sha256: "a".repeat(64), mimeType: "image/png" };
const B: SavedImage = { path: "/s/images/b.jpg", sha256: "b".repeat(64), mimeType: "image/jpeg" };

const req: VisionRequest = {
  requestId: "req-1",
  sessionId: "sess-1",
  userText: "what is wrong here?",
  images: [A, B],
  createdAt: "2026-11-02T00:00:00.000Z",
};

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: "req-1",
    status: "ok",
    description: "a chart",
    text_in_image: "Q3",
    findings_for_task: "axis is truncated",
    uncertainties: [],
    images: [
      { path: A.path, sha256: A.sha256 },
      { path: B.path, sha256: B.sha256 },
    ],
    ...over,
  };
}

function result(over: Partial<VisionResult> = {}): VisionResult {
  return {
    requestId: "req-1",
    status: "ok",
    description: "a chart",
    textInImage: "Q3",
    findingsForTask: "axis is truncated",
    uncertainties: [],
    images: [
      { path: A.path, sha256: A.sha256 },
      { path: B.path, sha256: B.sha256 },
    ],
    ...over,
  };
}

test("parseResult accepts a valid ok result", () => {
  const r = parseResult(raw(), req);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.result.requestId, "req-1");
    assert.equal(r.result.textInImage, "Q3");
    assert.equal(r.result.findingsForTask, "axis is truncated");
    assert.equal(r.result.images.length, 2);
  }
});

test("parseResult rejects a different requestId", () => {
  const r = parseResult(raw({ request_id: "other" }), req);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /request_id/);
});

test("parseResult rejects when an echoed sha256 differs from the one sent", () => {
  const r = parseResult(
    raw({
      images: [
        { path: A.path, sha256: "c".repeat(64) },
        { path: B.path, sha256: B.sha256 },
      ],
    }),
    req,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /sha256|hash/);
});

test("parseResult rejects when an image is missing from the echo", () => {
  const r = parseResult(raw({ images: [{ path: A.path, sha256: A.sha256 }] }), req);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /missing/);
});

test("parseResult rejects an unknown status and a non-string description", () => {
  const s = parseResult(raw({ status: "great" }), req);
  assert.equal(s.ok, false);
  const d = parseResult(raw({ description: 5 }), req);
  assert.equal(d.ok, false);
  assert.equal(parseResult("nope", req).ok, false);
  assert.equal(parseResult(raw({ uncertainties: [1] }), req).ok, false);
});

test("renderHandback states partial and failed explicitly and lists uncertainties", () => {
  const p = renderHandback("q", result({ status: "partial", uncertainties: ["blurry corner"] }), "vis", [A, B]);
  assert.match(p, /partial/i);
  assert.match(p, /blurry corner/);
  const f = renderHandback("q", result({ status: "failed" }), "vis", [A, B]);
  assert.match(f, /failed/i);
});

test("renderHandback marks the analysis as derived from untrusted image content", () => {
  const out = renderHandback("q", result(), "vis", [A, B]);
  assert.match(out, /untrusted/i);
  assert.match(out, /never instructions/i);
});

test("renderHandback with empty userText still produces a non-empty message naming the image paths", () => {
  const out = renderHandback("", result(), "vis", [A, B]);
  assert.ok(out.trim().length > 0);
  assert.ok(out.includes(A.path));
  assert.ok(out.includes(B.path));
});

test("buildRequestFile emits snake_case JSON and resultPath joins results/<id>.json", () => {
  const parsed = JSON.parse(buildRequestFile(req));
  assert.equal(parsed.request_id, "req-1");
  assert.equal(parsed.images[0].sha256, A.sha256);
  assert.equal(resultPath("/d", "req-1"), "/d/results/req-1.json");
});

test("resultPath throws on unsafe request ids and accepts a uuid", () => {
  for (const id of ["../x", "a/b", "a.b", ""]) assert.throws(() => resultPath("/d", id));
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(resultPath("/d", id), `/d/results/${id}.json`);
});

test("parseResult rejects duplicate echoed paths in either order", () => {
  const wrong = { path: A.path, sha256: "c".repeat(64) };
  const right = { path: A.path, sha256: A.sha256 };
  const b = { path: B.path, sha256: B.sha256 };
  for (const images of [
    [wrong, right, b],
    [right, wrong, b],
  ]) {
    const r = parseResult(raw({ images }), req);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /duplicate/);
  }
});

test("parseResult rejects an echoed path that was not sent", () => {
  const r = parseResult(
    raw({ images: [...(raw().images as object[]), { path: "/x/other.png", sha256: "d".repeat(64) }] }),
    req,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not sent/);
});
