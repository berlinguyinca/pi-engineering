import assert from "node:assert/strict";
import { test } from "node:test";

import { herdWorkspaceLabel, paneLink, parsePaneLink, tidyAgentName } from "../../src/runtime/herdr/CollabLayout.ts";
import { ControlPlaneIngest } from "../../src/runtime/herdr/ControlPlaneIngest.ts";

test("names are tidied like the control plane does", () => {
  assert.equal(tidyAgentName("Fresh Name!"), "fresh-name");
  assert.equal(tidyAgentName("!!!"), null);
  assert.equal(tidyAgentName("a".repeat(60))?.length, 32);
  assert.equal(herdWorkspaceLabel("Fleet 1"), "herd-fleet-1");
  assert.equal(herdWorkspaceLabel("???"), "herd-fleet");
});

test("pane links round-trip and reject anything else", () => {
  const link = paneLink("bender", "w2B:p1");
  assert.equal(link, "pane:bender:w2B:p1");
  assert.deepEqual(parsePaneLink(link as string), { hostId: "bender", paneId: "w2B:p1" });
  assert.equal(paneLink("bender", "p 1;rm"), null);
  assert.equal(parsePaneLink("herdr:a:b:c"), null);
});

test("session events carry the pane link, parent and name only when given", async () => {
  const bodies: Record<string, unknown>[] = [];
  const ingest = new ControlPlaneIngest({
    url: "http://cp",
    host: { hostId: "bender" },
    fetch: (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await ingest.session("s1", "session.started", {
    instanceId: "pane:bender:p1",
    parentSessionId: "s0",
    name: "worker-1",
    paneId: "w1:p1",
  });
  await ingest.session("s2", "session.started", {});
  const text = JSON.stringify(bodies);
  assert.match(text, /"instance_id":"pane:bender:p1"/);
  assert.match(text, /"parent_session_id":"s0"/);
  assert.match(text, /"pane_id":"w1:p1"/);
  assert.equal((text.match(/instance_id/g) ?? []).length, 1);
});
