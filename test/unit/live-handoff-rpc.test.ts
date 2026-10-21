/**
 * Unit tests for `server.live_handoff` (spec Unit D1, issue #351): the RPC
 * params builder/validator, the HandoffArtifact + checkpoint-refs payload
 * round-trip (in-process and across two real processes), and the socket
 * client against a live fake Herdr server implementing the RPC.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { HerdrError } from "../../src/runtime/herdr/HerdrCli.ts";
import {
  LIVE_HANDOFF_METHOD,
  PAYLOAD_MAX_DIFF_CHARS,
  PAYLOAD_MAX_SUMMARY_CHARS,
  buildLiveHandoffParams,
  callHerdrLiveHandoff,
  deserializeLiveHandoffPayload,
  probeLiveHandoffCapability,
  serializeLiveHandoffPayload,
  validateLiveHandoffParams,
} from "../../src/runtime/herdr/liveHandoff.ts";

const exec = promisify(execFile);

const tmpRoot = await mkdtemp(path.join(tmpdir(), "live-handoff-test-"));

// ── params builder/validator ────────────────────────────────────────────────

describe("live_handoff params", () => {
  it("builds sparse wire params, omitting null and undefined", () => {
    assert.deepEqual(buildLiveHandoffParams({}), {});
    assert.deepEqual(buildLiveHandoffParams({ expected_protocol: null, import_exe: "~/.local/bin/herdr" }), {
      import_exe: "~/.local/bin/herdr",
    });
    assert.deepEqual(buildLiveHandoffParams({ expected_protocol: 22, expected_version: "0.9.1" }), {
      expected_protocol: 22,
      expected_version: "0.9.1",
    });
  });

  it("validates the schema shape", () => {
    const ok = validateLiveHandoffParams({ expected_protocol: 22, import_exe: "/x/herdr" });
    assert.equal(ok.ok, true);

    const bad = validateLiveHandoffParams({ expected_protocol: -1, bogus: 1 });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(bad.errors.some((e) => e.includes("expected_protocol")));
      assert.ok(bad.errors.some((e) => e.includes("unknown param bogus")));
    }

    const badVersion = validateLiveHandoffParams({ expected_version: "" });
    assert.equal(badVersion.ok, false);
  });
});

// ── payload round-trip ──────────────────────────────────────────────────────

function makeArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "delegation",
    mission_id: "MSN-test",
    task_id: "TSK-test",
    from_role: "planner",
    to_role: "implementer",
    mission_summary: "s".repeat(100),
    architectural_context: ["ctx"],
    objective: "do it",
    relevant_files: ["src/x.ts"],
    decisions: ["d1"],
    constraints: ["c1"],
    acceptance: ["a1"],
    verification: ["v1"],
    scope: { files: ["src/**"] },
    dependency_results: [],
    token_estimate: 42,
    worker_outcome: {
      summary: "did it",
      changed_files: ["src/x.ts"],
      diff: "d".repeat(PAYLOAD_MAX_DIFF_CHARS),
      verification: ["ok"],
    },
    ...overrides,
  };
}

const REFS = {
  checkpointSha: "a".repeat(40),
  sourceSha: "b".repeat(40),
  artifacts: [{ ref: "artifact://x", sha256: "c".repeat(64) }],
};

describe("live_handoff payload", () => {
  it("round-trips artifact + checkpoint refs (in-process)", () => {
    const json = serializeLiveHandoffPayload({ artifact: makeArtifact(), checkpointRefs: REFS });
    const result = deserializeLiveHandoffPayload(json);
    assert.equal(result.ok, true, result.ok ? undefined : result.errors.join("; "));
    if (!result.ok) return;
    assert.equal(result.payload.payloadVersion, 1);
    assert.deepEqual(result.payload.artifact, makeArtifact());
    assert.deepEqual(result.payload.checkpointRefs, REFS);
  });

  it("omits checkpointRefs when absent", () => {
    const json = serializeLiveHandoffPayload({ artifact: makeArtifact() });
    const result = deserializeLiveHandoffPayload(json);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.payload.checkpointRefs, undefined);
  });

  it("rejects malformed payloads with field-level errors", () => {
    assert.equal(deserializeLiveHandoffPayload("not json").ok, false);

    const badKind = deserializeLiveHandoffPayload(
      serializeLiveHandoffPayload({ artifact: makeArtifact({ kind: "warp" }) }),
    );
    assert.equal(badKind.ok, false);
    if (!badKind.ok) assert.ok(badKind.errors.some((e) => e.includes("artifact.kind")));

    const longSummary = deserializeLiveHandoffPayload(
      serializeLiveHandoffPayload({
        artifact: makeArtifact({ mission_summary: "x".repeat(PAYLOAD_MAX_SUMMARY_CHARS + 1) }),
      }),
    );
    assert.equal(longSummary.ok, false);
    if (!longSummary.ok) assert.ok(longSummary.errors.some((e) => e.includes("mission_summary")));

    const longDiff = deserializeLiveHandoffPayload(
      serializeLiveHandoffPayload({
        artifact: makeArtifact({
          worker_outcome: {
            summary: "s",
            changed_files: [],
            diff: "x".repeat(PAYLOAD_MAX_DIFF_CHARS + 1),
            verification: [],
          },
        }),
      }),
    );
    assert.equal(longDiff.ok, false);
    if (!longDiff.ok) assert.ok(longDiff.errors.some((e) => e.includes("worker_outcome.diff")));

    const badRefs = deserializeLiveHandoffPayload(
      JSON.stringify({
        payloadVersion: 1,
        artifact: makeArtifact(),
        checkpointRefs: { checkpointSha: "zzz", sourceSha: "b".repeat(40), artifacts: [] },
      }),
    );
    assert.equal(badRefs.ok, false);
    if (!badRefs.ok) assert.ok(badRefs.errors.some((e) => e.includes("checkpointSha")));

    const wrongVersion = deserializeLiveHandoffPayload(
      JSON.stringify({ payloadVersion: 99, artifact: makeArtifact() }),
    );
    assert.equal(wrongVersion.ok, false);

    const missingArtifact = deserializeLiveHandoffPayload(JSON.stringify({ payloadVersion: 1 }));
    assert.equal(missingArtifact.ok, false);
  });
});

// ── fake Herdr socket server ────────────────────────────────────────────────

interface FakeServer {
  socketPath: string;
  /** Records every request line the server received. */
  requests: string[];
  close(): Promise<void>;
}

async function startFakeHerdrServer(
  handler: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<FakeServer> {
  const dir = await mkdtemp(path.join(tmpRoot, "sock-"));
  const socketPath = path.join(dir, "herdr.sock");
  const requests: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      requests.push(line);
      const request = JSON.parse(line) as Record<string, unknown>;
      socket.write(`${JSON.stringify(handler(request))}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // NOTE: promise form on purpose — the callback form of fs.rm never
      // settles on this Node version (22.23) for a dir that held a unix socket.
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ── socket client: the server.live_handoff handler responds (AC) ────────────

describe("server.live_handoff over the socket", () => {
  it("the handler responds to a request (success envelope)", async () => {
    const seen: Record<string, unknown>[] = [];
    const server = await startFakeHerdrServer((request) => {
      seen.push(request);
      if (request.method === LIVE_HANDOFF_METHOD) {
        return { id: request.id, result: { type: "ok" } };
      }
      return { id: request.id, result: { type: "pong", version: "0.9.1", protocol: 22 } };
    });
    try {
      const result = await callHerdrLiveHandoff({ socketPath: server.socketPath }, { import_exe: "/x/herdr" });
      assert.deepEqual(result, { type: "ok" });
      const wire = JSON.parse(server.requests[0]!) as Record<string, unknown>;
      assert.equal(wire.id, "pi-eng:live-handoff");
      assert.equal(wire.method, LIVE_HANDOFF_METHOD);
      assert.deepEqual(wire.params, { import_exe: "/x/herdr" });
      assert.equal(seen.length, 1, "exactly one request reached the handler");
    } finally {
      await server.close();
    }
  });

  it("normalizes server error envelopes to HerdrError", async () => {
    const server = await startFakeHerdrServer((request) => ({
      id: request.id,
      error: { code: "import_exe_not_found", message: "no such file" },
    }));
    try {
      await assert.rejects(
        callHerdrLiveHandoff({ socketPath: server.socketPath }, { import_exe: "/nope" }),
        (err: unknown) => err instanceof HerdrError && err.code === "import_exe_not_found",
      );
    } finally {
      await server.close();
    }
  });

  it("times out when the server never answers", async () => {
    const dir = await mkdtemp(path.join(tmpRoot, "silent-"));
    const socketPath = path.join(dir, "herdr.sock");
    const server = net.createServer((socket) => {
      // accept, then never respond. The socket IS read (discarded) so that
      // EOF is delivered as 'end' — a paused stream never emits it — and the
      // connection closes when the client gives up.
      socket.on("error", () => {});
      socket.on("data", () => {});
      socket.on("end", () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await assert.rejects(
        callHerdrLiveHandoff({ socketPath, timeoutMs: 200 }, {}),
        (err: unknown) => err instanceof HerdrError && err.code === "live_handoff_timeout",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── capability probe ────────────────────────────────────────────────────────

describe("probeLiveHandoffCapability", () => {
  it("reads capabilities.live_handoff from the server", async () => {
    const server = await startFakeHerdrServer((request) => ({
      id: request.id,
      result: {
        type: "pong",
        version: "0.9.1",
        protocol: 22,
        capabilities: { live_handoff: true, detached_server_daemon: true },
      },
    }));
    try {
      const probe = await probeLiveHandoffCapability({ socketPath: server.socketPath });
      assert.deepEqual(probe, { reachable: true, liveHandoff: true, version: "0.9.1", protocol: 22 });
    } finally {
      await server.close();
    }
  });

  it("reports a server without the capability", async () => {
    const server = await startFakeHerdrServer((request) => ({
      id: request.id,
      result: { type: "pong", version: "0.8.0", protocol: 20, capabilities: { live_handoff: false } },
    }));
    try {
      const probe = await probeLiveHandoffCapability({ socketPath: server.socketPath });
      assert.equal(probe.reachable, true);
      assert.equal(probe.liveHandoff, false);
    } finally {
      await server.close();
    }
  });

  it("resolves unreachable as not-reachable (no throw)", async () => {
    const probe = await probeLiveHandoffCapability({
      socketPath: path.join(tmpRoot, "no-such-socket.sock"),
      timeoutMs: 500,
    });
    assert.deepEqual(probe, { reachable: false, liveHandoff: false });
  });
});

// ── two-process round-trip (AC) ─────────────────────────────────────────────

describe("HandoffArtifact round-trips between two processes", () => {
  it("parent serializes, child deserializes + re-serializes, parent verifies", async () => {
    const dir = await mkdtemp(path.join(tmpRoot, "xproc-"));
    const inFile = path.join(dir, "in.json");
    const outFile = path.join(dir, "out.json");
    const childScript = path.join(dir, "child.ts");
    const modulePath = path.resolve(import.meta.dirname, "../../src/runtime/herdr/liveHandoff.ts");

    const artifact = makeArtifact();
    const json = serializeLiveHandoffPayload({ artifact, checkpointRefs: REFS });
    await writeFile(inFile, json);
    await writeFile(
      childScript,
      [
        `import { readFileSync, writeFileSync } from "node:fs";`,
        `import { deserializeLiveHandoffPayload, serializeLiveHandoffPayload } from ${JSON.stringify(modulePath)};`,
        `const result = deserializeLiveHandoffPayload(readFileSync(process.argv[2]!, "utf8"));`,
        `if (!result.ok) {`,
        `  process.stderr.write(JSON.stringify(result.errors));`,
        `  process.exit(1);`,
        `}`,
        `writeFileSync(`,
        `  process.argv[3]!,`,
        `  serializeLiveHandoffPayload({ artifact: result.payload.artifact, checkpointRefs: result.payload.checkpointRefs }),`,
        `);`,
        ``,
      ].join("\n"),
    );

    await exec(process.execPath, [childScript, inFile, outFile]);

    const childResult = deserializeLiveHandoffPayload(await readFile(outFile, "utf8"));
    assert.equal(childResult.ok, true, childResult.ok ? undefined : childResult.errors.join("; "));
    if (!childResult.ok) return;
    assert.deepEqual(childResult.payload.artifact, artifact);
    assert.deepEqual(childResult.payload.checkpointRefs, REFS);
  });
});

// ── cleanup ─────────────────────────────────────────────────────────────────

after(() => {
  void rm(tmpRoot, { recursive: true, force: true });
});
