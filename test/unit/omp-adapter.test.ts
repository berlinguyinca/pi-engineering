import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OMP_PIN_MANIFEST,
  UnavailableReason,
  buildCapabilityReport,
  decodeNegotiateResponse,
  decodeReadyFrame,
  encodeNegotiateRequest,
  isVersionPinned,
  negotiateOmpFromEnv,
  parseFrameLine,
  parseSemVer,
  parseVersionOutput,
  resolveOmpAdapterConfig,
  selectProtocol,
} from "../../src/omp/index.ts";

// Frame text copied verbatim from a real `omp 18.20.0 --mode rpc` run (see phase2 report).
const REAL_READY =
  '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864,"supportsBashExcludeFromContext":true}';
const REAL_NEGOTIATE_OK =
  '{"id":"n1","type":"response","command":"negotiate_protocol","success":true,"data":{"protocolVersion":2}}';
const REAL_NEGOTIATE_REJECT =
  '{"id":"n2","type":"response","command":"negotiate_protocol","success":false,"error":"Unsupported RPC protocol version: 3"}';

test("omp semver: parse and pin range boundaries", () => {
  assert.deepEqual(parseSemVer("18.20.0"), { major: 18, minor: 20, patch: 0 });
  assert.equal(parseSemVer("18.20"), null);
  assert.equal(parseSemVer("latest"), null);
  const pinned = (v: string) =>
    isVersionPinned(parseSemVer(v) as NonNullable<ReturnType<typeof parseSemVer>>, OMP_PIN_MANIFEST);
  assert.equal(pinned("18.19.9"), false);
  assert.equal(pinned("18.20.0"), true);
  assert.equal(pinned("18.20.99"), true);
  assert.equal(pinned("18.21.0"), false);
  assert.equal(pinned("19.0.0"), false);
});

test("omp version output: parses omp/X.Y.Z and rejects others", () => {
  assert.equal(parseVersionOutput("omp/18.20.0\n"), "18.20.0");
  assert.equal(parseVersionOutput("v22.1.0"), null);
  assert.equal(parseVersionOutput(""), null);
});

test("omp frames: real ready frame decodes", () => {
  const frame = parseFrameLine(REAL_READY);
  assert.ok(frame);
  assert.deepEqual(decodeReadyFrame(frame), {
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1048576,
    maxReassembledFrameBytes: 67108864,
    supportsBashExcludeFromContext: true,
  });
});

test("omp frames: malformed and non-ready frames are rejected", () => {
  assert.equal(parseFrameLine("not json"), null);
  assert.equal(parseFrameLine("[1,2]"), null);
  assert.equal(parseFrameLine("   "), null);
  assert.equal(decodeReadyFrame({ type: "response" }), null);
  assert.equal(decodeReadyFrame({ type: "ready", protocolVersion: "1" }), null);
  assert.equal(
    decodeReadyFrame({ type: "ready", protocolVersion: 1, supportedProtocolVersions: ["1"], maxFrameBytes: 1 }),
    null,
  );
  const old = decodeReadyFrame({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1],
    maxFrameBytes: 10,
  });
  assert.equal(old?.supportsBashExcludeFromContext, false);
  assert.equal(old?.maxReassembledFrameBytes, null);
});

test("omp frames: negotiate request and responses", () => {
  assert.equal(encodeNegotiateRequest("a", 2), '{"id":"a","type":"negotiate_protocol","protocolVersion":2}\n');
  const ok = parseFrameLine(REAL_NEGOTIATE_OK);
  const rej = parseFrameLine(REAL_NEGOTIATE_REJECT);
  assert.ok(ok && rej);
  assert.deepEqual(decodeNegotiateResponse(ok, "n1"), { kind: "accepted", protocolVersion: 2 });
  assert.equal(decodeNegotiateResponse(ok, "other"), null);
  assert.deepEqual(decodeNegotiateResponse(rej, "n2"), {
    kind: "rejected",
    error: "Unsupported RPC protocol version: 3",
  });
  assert.equal(decodeNegotiateResponse({ type: "ready" }, "n1"), null);
});

test("omp report: protocol selection and report building", () => {
  const frame = parseFrameLine(REAL_READY);
  assert.ok(frame);
  const ready = decodeReadyFrame(frame);
  assert.ok(ready);
  assert.equal(selectProtocol(ready, OMP_PIN_MANIFEST), 2);
  assert.equal(selectProtocol(ready, { ...OMP_PIN_MANIFEST, acceptedProtocolVersions: [1] }), 1);
  assert.equal(selectProtocol(ready, { ...OMP_PIN_MANIFEST, acceptedProtocolVersions: [] }), null);
  assert.equal(selectProtocol({ ...ready, supportedProtocolVersions: [3] }, OMP_PIN_MANIFEST), null);
  const report = buildCapabilityReport("18.20.0", ready, 2);
  assert.equal(report.chunkedFrames, true);
  assert.equal(report.bashExcludeFromContext, true);
  assert.equal(buildCapabilityReport("18.20.0", ready, 1).chunkedFrames, false);
});

test("omp config: default OFF, explicit enable, bin and timeout overrides", () => {
  assert.equal(resolveOmpAdapterConfig({}).enabled, false);
  assert.equal(resolveOmpAdapterConfig({ PI_ENGINEERING_OMP_ADAPTER: "0" }).enabled, false);
  assert.equal(resolveOmpAdapterConfig({ PI_ENGINEERING_OMP_ADAPTER: "bogus" }).enabled, false);
  const on = resolveOmpAdapterConfig({
    PI_ENGINEERING_OMP_ADAPTER: "1",
    PI_ENGINEERING_OMP_BIN: "/x/omp",
    PI_ENGINEERING_OMP_TIMEOUT_MS: "5s",
  });
  assert.deepEqual(on, { enabled: true, launch: { command: "/x/omp", args: [] }, timeoutMs: 5000 });
  assert.equal(resolveOmpAdapterConfig({ PI_ENGINEERING_OMP_ADAPTER: "true" }).launch.command, "omp");
  assert.equal(resolveOmpAdapterConfig({ PI_ENGINEERING_OMP_TIMEOUT_MS: "junk" }).timeoutMs, 15_000);
});

test("omp adapter: disabled by default returns Unavailable{disabled} without spawning", async () => {
  // Bin points at a nonexistent path: if anything spawned, the reason would be binary_absent.
  const result = await negotiateOmpFromEnv({ PI_ENGINEERING_OMP_BIN: "/nonexistent/omp" });
  assert.deepEqual(result, {
    kind: "unavailable",
    reason: UnavailableReason.Disabled,
    detail: "PI_ENGINEERING_OMP_ADAPTER not enabled",
  });
});

test("omp semver: pre-release and build suffixes are rejected (policy: releases only)", () => {
  assert.equal(parseSemVer("18.20.0-rc.1"), null);
  assert.equal(parseSemVer("18.20.0+build.5"), null);
  assert.equal(parseSemVer("v18.20.0-beta"), null);
  assert.deepEqual(parseSemVer("v18.20.0"), { major: 18, minor: 20, patch: 0 });
});
