// The Pi side of the three Herdr T16 gap routes: the live steering fence read, the fork instruction (see
// herdr-forks.test.ts) and the re-review request. Connection-layer tests opt back in from the harness-wide
// HERDR_DISABLED default (test/support/isolatedState.ts).
delete process.env.HERDR_DISABLED;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverGithubLinks } from "../../src/github/discovery.ts";
import { linkPullRequest } from "../../src/github/prLinks.ts";
import { createHerdrRereviewRequester } from "../../src/github/quorum.ts";
import { type GithubRef, parseGithubRef } from "../../src/github/refs.ts";
import { githubSync } from "../../src/github/sync.ts";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import {
  type LiveTargetRead,
  MemorySteeringLedger,
  type SteeringPorts,
  applySteering,
  parseSteeringItem,
} from "../../src/orchestration/steering.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import { SteeringReceiver } from "../../src/runtime/herdr/SteeringReceiver.ts";
import { FakeGithubClient } from "../support/fakeGithubClient.ts";

// ─── steering: the live fence read ───────────────────────────────────────────────────────────────

const wire = (over: Record<string, unknown> = {}) => ({
  steering_id: "st-1",
  action: "redirect",
  target: { node_id: "task:t1", fence: "F1" },
  instruction: "prefer the smaller change",
  proposed_by: { id: "alice" },
  confirmed_by: { id: "bob" },
  room: { id: "room-a" },
  trust: "untrusted",
  valid_until_epoch: 2_000,
  ...over,
});
const item = (over: Record<string, unknown> = {}) => {
  const i = parseSteeringItem(wire(over));
  assert.ok(i);
  return i;
};
const steered: string[] = [];
const ports = (): SteeringPorts => ({
  now: () => 1_000,
  resolve: () => ({ kind: "task", taskId: "t1", missionId: "m1", running: true, terminal: false, digest: "D1" }),
  steerRunning: (id) => {
    steered.push(id);
    return "delivered";
  },
  resumeMission: async () => ({ changed: true }),
});
const ok = (over: Partial<Extract<LiveTargetRead, { status: "ok" }>> = {}): LiveTargetRead => ({
  status: "ok",
  fence: "F1",
  digest: "D1",
  superseded: false,
  ...over,
});

describe("apply-time fence: Herdr's current view decides, fail closed", () => {
  it("applies when Herdr's current fence is the one the request carried", async () => {
    steered.length = 0;
    const ack = await applySteering(item(), ports(), new MemorySteeringLedger(), undefined, async () => ok());
    assert.equal(ack?.outcome, "applied");
    assert.equal(steered.length, 1);
  });
  it("a changed fence, a superseded target and a changed digest are stale and nothing is steered", async () => {
    for (const [name, read, extra] of [
      ["fence", ok({ fence: "F2" }), {}],
      ["null fence", ok({ fence: null }), {}],
      ["superseded", ok({ superseded: true }), {}],
      ["digest", ok({ digest: "D2" }), { target: { node_id: "task:t1", fence: "F1", expected_digest: "D1" } }],
    ] as const) {
      steered.length = 0;
      const ledger = new MemorySteeringLedger();
      const ack = await applySteering(item(extra), ports(), ledger, undefined, async () => read);
      assert.equal(ack?.outcome, "stale", name);
      assert.equal(steered.length, 0, name);
      assert.equal(ledger.get("st-1")?.state, "done", `${name}: recorded, so it is never applied later`);
    }
  });
  it("a digest naming ANY of the node's digest attributes (plan_digest, commit, ...) matches, as on Herdr's side", async () => {
    const named = { target: { node_id: "task:t1", fence: "F1", expected_digest: "C" } };
    steered.length = 0;
    const hit = await applySteering(
      item(named),
      {
        ...ports(),
        resolve: () => ({ kind: "task", taskId: "t1", missionId: "m1", running: true, terminal: false, digest: "C" }),
      },
      new MemorySteeringLedger(),
      undefined,
      async () => ok({ digest: "P", digests: ["P", "C"] }),
    );
    assert.equal(hit?.outcome, "applied");
    const miss = await applySteering(
      item({ ...named, steering_id: "st-9" }),
      {
        ...ports(),
        resolve: () => ({ kind: "task", taskId: "t1", missionId: "m1", running: true, terminal: false, digest: "C" }),
      },
      new MemorySteeringLedger(),
      undefined,
      async () => ok({ digest: "P", digests: ["P", "Q"] }),
    );
    assert.equal(miss?.outcome, "stale");
  });
  it("Herdr's 404 (no live request for this key) is stale", async () => {
    const ack = await applySteering(item(), ports(), new MemorySteeringLedger(), undefined, async () => ({
      status: "gone",
    }));
    assert.equal(ack?.outcome, "stale");
    assert.match(ack?.note ?? "", /no longer holds a live request/);
  });
  it("a read that fails or throws leaves the request alone: no ack, no ledger row, nothing applied", async () => {
    for (const reader of [
      async (): Promise<LiveTargetRead> => ({ status: "unavailable" }),
      async (): Promise<LiveTargetRead> => {
        throw new Error("boom");
      },
    ]) {
      steered.length = 0;
      const ledger = new MemorySteeringLedger();
      assert.equal(await applySteering(item(), ports(), ledger, undefined, reader), null);
      assert.equal(ledger.get("st-1"), undefined);
      assert.equal(steered.length, 0);
    }
  });
  it("the reader is not asked when the request names neither a fence nor a digest, or when it is already expired", async () => {
    let asked = 0;
    const reader = async (): Promise<LiveTargetRead> => {
      asked++;
      return ok();
    };
    await applySteering(
      item({ target: { node_id: "task:t1" } }),
      ports(),
      new MemorySteeringLedger(),
      undefined,
      reader,
    );
    await applySteering(
      item({ steering_id: "st-2", valid_until_epoch: 5 }),
      ports(),
      new MemorySteeringLedger(),
      undefined,
      reader,
    );
    assert.equal(asked, 0);
  });
  it("a fork is held to the same check", async () => {
    let applied = 0;
    const p: SteeringPorts = {
      ...ports(),
      forks: {
        knows: () => true,
        apply: async () => {
          applied++;
          return { outcome: "applied", note: "x" };
        },
      },
    };
    const fork = item({
      action: "fork",
      instruction: null,
      params: { base_sha: "a".repeat(40), label: "x" },
    });
    const stale = await applySteering(fork, p, new MemorySteeringLedger(), undefined, async () => ok({ fence: "F9" }));
    assert.equal(stale?.outcome, "stale");
    assert.equal(applied, 0);
    const fine = await applySteering(
      item({ steering_id: "st-3", action: "fork", instruction: null, params: { base_sha: "a".repeat(40) } }),
      p,
      new MemorySteeringLedger(),
      undefined,
      async () => ok(),
    );
    assert.equal(fine?.outcome, "applied");
  });
});

describe("the receiver reads Herdr's live target with its own key", () => {
  const run = async (targets: (url: string) => Response | Promise<Response>) => {
    const urls: Array<{ url: string; key: string | undefined }> = [];
    const acks: Array<{ url: string; body: string }> = [];
    steered.length = 0;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const key = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
      urls.push({ url, key });
      if (url.includes("/steering/pending")) {
        return new Response(JSON.stringify({ steering: [wire()] }), { status: 200 });
      }
      if (url.includes("/steering/targets/")) return targets(url);
      acks.push({ url, body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const rx = new SteeringReceiver({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k-live",
      instanceId: "inst-a",
      ports: ports(),
      ledger: new MemorySteeringLedger(),
      fetch: fetchImpl,
    });
    return { result: await rx.pollOnce(), urls, acks };
  };
  const body = (o: Record<string, unknown>) => new Response(JSON.stringify(o), { status: 200 });

  it("asks the targets route (key header, instance id, no redirects) and applies on a matching fence", async () => {
    const r = await run(() => body({ node_id: "task:t1", fence: "F1", digest: "D1", superseded: false }));
    const t = r.urls.find((u) => u.url.includes("/targets/"));
    assert.equal(t?.url, "http://127.0.0.1:1/api/v1/steering/targets/task%3At1?instance_id=inst-a");
    assert.equal(t?.key, "k-live");
    assert.equal(r.result.acked, 1);
    assert.equal(JSON.parse(r.acks[0]?.body ?? "{}").outcome, "applied");
  });
  it("a different fence is acknowledged stale", async () => {
    const r = await run(() => body({ fence: "F2", digest: null, superseded: false }));
    assert.equal(JSON.parse(r.acks[0]?.body ?? "{}").outcome, "stale");
    assert.equal(steered.length, 0);
  });
  it("two overlapping polls never apply a request twice", async () => {
    steered.length = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchImpl = (async (input: string) => {
      const url = String(input);
      if (url.includes("/steering/pending"))
        return new Response(JSON.stringify({ steering: [wire()] }), { status: 200 });
      if (url.includes("/steering/targets/")) {
        await gate;
        return new Response(JSON.stringify({ fence: "F1", digest: null, superseded: false }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const rx = new SteeringReceiver({
      baseUrl: "http://127.0.0.1:1",
      ports: ports(),
      ledger: new MemorySteeringLedger(),
      fetch: fetchImpl,
    });
    const first = rx.pollOnce();
    const second = await rx.pollOnce();
    assert.match(second.error ?? "", /already running/);
    release();
    assert.equal((await first).acked, 1);
    assert.equal(steered.length, 1);
  });
  it("404 is stale; 5xx, 429, a malformed body and a network error are left for the next poll", async () => {
    const gone = await run(() => new Response("{}", { status: 404 }));
    assert.equal(JSON.parse(gone.acks[0]?.body ?? "{}").outcome, "stale");
    for (const t of [
      () => new Response("x", { status: 503 }),
      () => new Response("x", { status: 429 }),
      () => body({ fence: 7 }),
      () => new Response("<html>", { status: 200 }),
      () => {
        throw new Error("down");
      },
    ]) {
      const r = await run(t);
      assert.equal(r.result.acked, 0);
      assert.equal(r.result.skipped, 1);
      assert.equal(r.acks.length, 0);
      assert.equal(steered.length, 0);
    }
  });
});

// ─── re-review request ───────────────────────────────────────────────────────────────────────────

describe("the Herdr re-review requester", () => {
  const SHA = "a".repeat(40);
  const make = (answer: (url: string, init: RequestInit) => Response | Promise<Response>, apiKey = "k-1") => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer(url, init);
    }) as unknown as typeof fetch;
    return { ask: createHerdrRereviewRequester({ baseUrl: "http://127.0.0.1:1", apiKey }, f), calls };
  };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });

  it("POSTs the head with Pi's key; 201 and 200 are ok and carry the request id", async () => {
    for (const status of [201, 200]) {
      const { ask, calls } = make(() => json(status, { rereview_request: { request_id: "req-1", head: SHA } }));
      assert.deepEqual(await ask("pr:github.com/a/b#1", SHA), { state: "ok", requestId: "req-1" });
      assert.equal(
        calls[0]?.url,
        "http://127.0.0.1:1/api/v1/graph/nodes/pr%3Agithub.com%2Fa%2Fb%231/review-quorum/rereview",
      );
      assert.equal(calls[0]?.init.method, "POST");
      assert.equal(calls[0]?.init.redirect, "error");
      assert.equal((calls[0]?.init.headers as Record<string, string>)["X-API-Key"], "k-1");
      assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { head: SHA });
    }
  });
  it("an upper-case full head is sent lower-cased", async () => {
    const { ask, calls } = make(() => json(201, {}));
    await ask("pr:x/y/z#1", "A".repeat(40));
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { head: "a".repeat(40) });
  });
  it("a head that is not a full commit id is left out (Herdr then uses the current head)", async () => {
    const { ask, calls } = make(() => json(201, {}));
    await ask("pr:x/y/z#1", "abc123");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {});
  });
  it("403, 404 and 409 not_required are final; stale_head, head_unknown, 429, 5xx and network are retried", async () => {
    const final: Array<[number, unknown]> = [
      [403, { code: "not_permitted" }],
      [404, { error: "not found" }],
      [409, { code: "not_required" }],
    ];
    for (const [status, b] of final) {
      const { ask } = make(() => json(status, b));
      assert.equal((await ask("pr:x/y/z#1", SHA)).state, "refused", String(status));
    }
    const retry: Array<[number, unknown]> = [
      [409, { code: "stale_head" }],
      [409, { code: "head_unknown" }],
      [429, { code: "rate_limited" }],
      [500, {}],
    ];
    for (const [status, b] of retry) {
      const { ask } = make(() => json(status, b));
      assert.equal((await ask("pr:x/y/z#1", SHA)).state, "failed", String(status));
    }
    const down = make(() => {
      throw new Error("down");
    });
    assert.deepEqual(await down.ask("pr:x/y/z#1", SHA), { state: "failed", reason: "unreachable" });
  });
  it("without a key nothing is sent; an odd error code is never echoed", async () => {
    const none = make(() => json(201, {}), "");
    assert.equal((await none.ask("pr:x/y/z#1", SHA)).state, "failed");
    assert.equal(none.calls.length, 0);
    const { ask } = make(() => json(409, { code: "Not A Code <script>" }));
    assert.equal((await ask("pr:x/y/z#1", SHA)).reason, "http_409");
  });
});

const cfg = { defaultRepo: "acme/widgets" };
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const ref = (t: string): GithubRef => {
  const r = parseGithubRef(t, cfg);
  if (!r.ok) throw new Error(r.reason);
  return r.ref;
};

describe("githubSync asks Herdr to record the re-review", () => {
  const moved = async () => {
    const store = MissionStore.open(JsonlEventStore.inMemory());
    const mission = store.createMission({
      title: "m",
      goal: "work on #12",
      user_request: "g",
      repository: ".",
      base_ref: "b",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const client = new FakeGithubClient();
    client.put("github.com/acme/widgets#12", { title: "Issue", state: "open" });
    client.put("github.com/acme/widgets#30", {
      title: "PR",
      state: "open",
      pr: { state: "open", headSha: SHA1, body: "x" },
    });
    const now = () => new Date(clock).toISOString();
    let clock = Date.parse("2026-10-23T00:00:00.000Z");
    await discoverGithubLinks(client, store, cfg, { missionId: mission.mission_id, goal: "work on #12" }, now);
    await linkPullRequest(
      client,
      store,
      {
        missionId: mission.mission_id,
        prRef: ref("https://github.com/acme/widgets/pull/30"),
        subjects: [{ kind: "task", id: "t1" }],
      },
      now,
    );
    const asks: Array<[string, string]> = [];
    let answers: Array<{ state: "ok" | "refused" | "failed"; requestId?: string }> = [];
    const tick = (over: Record<string, unknown> = {}) =>
      githubSync({
        client,
        store,
        cfg,
        lineage: null,
        now,
        rereview: async (pr, head) => {
          asks.push([pr, head]);
          return answers.shift() ?? { state: "ok", requestId: "req-x" };
        },
        ...over,
      });
    await tick();
    client.items.get("github.com/acme/widgets#30")!.pr!.headSha = SHA2;
    return {
      store,
      asks,
      tick,
      advance: (ms: number) => {
        clock += ms;
      },
      answers: (a: typeof answers) => {
        answers = a;
      },
    };
  };

  it("asks once per stale signal with the new head, stores the answer, and a second tick does not ask again", async () => {
    const w = await moved();
    const first = await w.tick();
    assert.deepEqual(w.asks, [["pr:github.com/acme/widgets#30", SHA2]]);
    assert.equal(first.rereviews[0]?.ask?.state, "ok");
    assert.equal(first.rereviews[0]?.ask?.requestId, "req-x");
    assert.equal(first.rereviews[0]?.dispatch, "none", "no command configured: only Herdr was asked");
    await w.tick();
    assert.equal(w.asks.length, 1);
    assert.equal(w.store.listGithubRereviews()[0]?.ask?.attempts, 1);
  });
  it("a failed ask is retried after a backoff and bounded; a refused ask is final", async () => {
    const w = await moved();
    w.answers([{ state: "failed" }, { state: "failed" }, { state: "ok" }]);
    await w.tick();
    assert.equal(w.asks.length, 1);
    await w.tick();
    assert.equal(w.asks.length, 1, "inside the backoff nothing is asked");
    w.advance(31_000);
    await w.tick();
    assert.equal(w.asks.length, 2);
    w.advance(61_000);
    await w.tick();
    assert.equal(w.asks.length, 3);
    w.advance(24 * 3600_000);
    await w.tick();
    assert.equal(w.asks.length, 3, "ok is final");

    const r = await moved();
    r.answers([{ state: "refused" }]);
    await r.tick();
    r.advance(24 * 3600_000);
    await r.tick();
    assert.equal(r.asks.length, 1, "refused is final");
    assert.equal(r.store.listGithubRereviews()[0]?.ask?.state, "refused");
  });
  it("the ask is bounded at five tries, each after its backoff", async () => {
    const w = await moved();
    w.answers(Array.from({ length: 8 }, () => ({ state: "failed" as const })));
    for (let i = 0; i < 9; i++) {
      await w.tick();
      w.advance(10 * 60_000);
    }
    assert.equal(w.asks.length, 5);
    assert.equal(w.store.listGithubRereviews()[0]?.ask?.state, "failed");
    assert.equal(w.store.listGithubRereviews()[0]?.ask?.attempts, 5);
  });
  it("a failing command and a failing ask are retried independently on the same signal", async () => {
    const w = await moved();
    let cmdOk = false;
    const cmd = {
      rereviewCommand: ["/bin/request"],
      run: async () => cmdOk,
    };
    w.answers([{ state: "failed" }, { state: "ok" }]);
    const first = await w.tick(cmd);
    assert.equal(first.rereviews[0]?.dispatch, "failed");
    assert.equal(first.rereviews[0]?.ask?.state, "failed");
    w.advance(61_000);
    cmdOk = true;
    const second = await w.tick(cmd);
    assert.equal(second.rereviews[0]?.dispatch, "ok");
    assert.equal(second.rereviews[0]?.ask?.state, "ok");
    assert.equal(w.asks.length, 2);
  });
  it("is independent of the operator command: both happen once, a thrown requester is a failed ask", async () => {
    const w = await moved();
    const ran: string[][] = [];
    const t = await w.tick({
      rereviewCommand: ["/bin/request"],
      run: async (argv: string[]) => {
        ran.push(argv);
        return true;
      },
    });
    assert.equal(ran.length, 1);
    assert.equal(w.asks.length, 1);
    assert.equal(t.rereviews[0]?.dispatch, "ok");
    assert.equal(t.rereviews[0]?.ask?.state, "ok");

    const boom = await moved();
    const f = await boom.tick({
      rereview: async () => {
        throw new Error("x");
      },
    });
    assert.equal(f.rereviews[0]?.ask?.state, "failed");
  });
  it("without a requester no ask is made and no ask is recorded (standalone Pi is unchanged)", async () => {
    const w = await moved();
    const t = await w.tick({ rereview: null });
    assert.equal(w.asks.length, 0);
    assert.equal(t.rereviews[0]?.ask, undefined);
  });
});
