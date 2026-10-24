import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoSpecIncidentSink } from "../../src/incidents/AutoSpecIncidentSink.ts";
import type { PublishedIncident } from "../../src/incidents/IncidentController.ts";

const event: PublishedIncident = {
  type: "agent_failure",
  schema_version: 1,
  incident_id: "inc_1",
  run_id: "run_1",
  repo: "owner/repo",
  revision: "abc123",
  worktree: "/tmp/worktree",
  agent_role: "executor",
  failure_class: "test_failure",
  exit_code: 1,
  summary: "test failed",
  artifact_refs: ["artifact://failure/log"],
  reproduction: "npm test",
  command: "npm test",
  root_cause: "AssertionError at src/lib.ts:4",
  classification: "product_defect",
  risk: "medium",
  created_at: "2026-10-24T00:00:00Z",
  fingerprint: "deadbeefdeadbeef",
};

test("autospec-incident-sink: sends an event file and removes it after success", async () => {
  let observedPath = "";
  const sink = new AutoSpecIncidentSink({
    root: tmpdir(),
    run: async (args) => {
      observedPath = args[args.indexOf("--event-file") + 1] ?? "";
      const body = JSON.parse(await readFile(observedPath, "utf8")) as PublishedIncident;
      assert.equal(body.fingerprint, event.fingerprint);
      assert.equal((await stat(observedPath)).mode & 0o077, 0);
      return JSON.stringify({ ok: true, issue: 921 });
    },
  });

  await sink.publish(event);

  await assert.rejects(readFile(observedPath), /ENOENT/);
});

test("autospec-incident-sink: preserves durable retry semantics on command failure", async () => {
  const sink = new AutoSpecIncidentSink({
    root: tmpdir(),
    run: async () => {
      throw new Error("AutoSpec unavailable");
    },
  });

  await assert.rejects(sink.publish(event), /AutoSpec unavailable/);
});

test("autospec-incident-sink: rejects malformed command output", async () => {
  const sink = new AutoSpecIncidentSink({
    root: tmpdir(),
    run: async () => "not-json",
  });

  await assert.rejects(sink.publish(event), /valid JSON|ok/);
});
