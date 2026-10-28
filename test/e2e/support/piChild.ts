/**
 * A separate Pi PROCESS for the kill -9 test. Usage: node piChild.ts <config.json>
 * It stages events in a durable EnvelopeStore directory, delivers the first one to the live plane, then goes offline
 * (its injected fetch fails) and stages two more, prints "QUEUED <n>" and waits to be killed by the parent test.
 */
import { readFileSync } from "node:fs";
import { ControlPlaneIngest } from "../../../src/runtime/herdr/ControlPlaneIngest.ts";
import { EnvelopeStore } from "../../../src/runtime/herdr/envelopeStore.ts";

const cfg = JSON.parse(readFileSync(process.argv[2] as string, "utf8")) as {
  dir: string;
  source: string;
  url: string;
  keyFile: string;
};
let offline = false;
const store = new EnvelopeStore({ dir: cfg.dir, source: cfg.source });
const ingest = new ControlPlaneIngest({
  url: cfg.url,
  apiKey: readFileSync(cfg.keyFile, "utf8").trim(),
  envelopeStore: store,
  backoff: { baseMs: 20, maxMs: 100, deadLetterAfter: 5 },
  timeoutMs: 1500,
  fetch: ((input: string | URL | Request, init?: RequestInit) =>
    offline ? Promise.reject(new Error("offline")) : globalThis.fetch(input, init)) as typeof globalThis.fetch,
});
const draft = (id: string) => ({
  occurred_at: new Date(),
  entity_type: "lineage",
  entity_id: id,
  event_type: "node.upsert",
  payload: { node_type: id.split(":")[0], node_id: id, state: "running" },
  visibility_scope: "org" as const,
});
await ingest.emitDraft(draft("agent:pk1") as never);
await ingest.flushOutbox();
console.log(`DELIVERED ${ingest.diagnostics()?.pending === 0}`);
offline = true;
await ingest.emitDraft(draft("agent:pk2") as never);
await ingest.emitDraft(draft("agent:pk3") as never);
console.log(`QUEUED ${ingest.diagnostics()?.pending}`);
setInterval(() => {}, 1000); // wait for SIGKILL
