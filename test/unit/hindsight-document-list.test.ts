import assert from "node:assert/strict";
import { test } from "node:test";
import { HindsightDurableMemory, type HindsightRunner } from "../../src/blackhole/hindsight.ts";

const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value) });
const item = (address: string, status = "verified") => ({
  address,
  document_id: "caller-id-is-not-the-address",
  status,
});
const record = (id: string, status = "verified", bank = "herdr-global") => ({
  memory_id: id,
  bank_id: bank,
  text: "synthetic test fact",
  status,
  revision: 2,
  kind: "fact",
});

test("recallAll enumerates bounded document pages and gets normalized addresses; never semantic overview", async () => {
  const calls: string[][] = [];
  const run: HindsightRunner = async (_, args) => {
    calls.push(args);
    if (args[0] === "documents") {
      const offset = Number(args[args.indexOf("--offset") + 1]);
      const addresses = Array.from({ length: offset === 0 ? 20 : 2 }, (_, i) => item(`mem-${offset + i}`));
      return ok({
        bank_id: "herdr-global",
        scope: "global",
        total: 22,
        total_is_estimate: false,
        documents: addresses,
      });
    }
    assert.equal(args[0], "get", "listing is not recall with a made-up query");
    assert.match(args[1]!, /^mem-/);
    assert.equal(args[args.indexOf("--scope") + 1], "global");
    return ok(record(args[1]!));
  };
  const rows = await new HindsightDurableMemory({ scopes: ["global"], run }).recallAll();
  assert.equal(rows.length, 22);
  assert.equal(rows[0]?.id, "mem-0");
  assert.equal(rows[21]?.id, "mem-21");
  assert.deepEqual(
    calls.filter((a) => a[0] === "documents").map((a) => a[a.indexOf("--offset") + 1]),
    ["0", "20"],
  );
  assert.ok(calls.every((a) => a[0] !== "recall"));
  assert.ok(calls.filter((a) => a[0] === "documents").every((a) => !a.includes("--timeout-ms")));
});

test("empty first project is healthy and does not hide a configured infra scope", async () => {
  const run: HindsightRunner = async (_, args) => {
    const scope = args[args.indexOf("--scope") + 1];
    if (args[0] === "documents")
      return ok({
        bank_id: scope === "project" ? "canary-facts" : "herdr-infra",
        scope,
        total: scope === "project" ? 0 : 1,
        total_is_estimate: false,
        documents: scope === "project" ? [] : [item("mem-policy")],
      });
    assert.equal(args[0], "get");
    return ok(record("mem-policy", "candidate", "herdr-infra"));
  };
  const p = new HindsightDurableMemory({ scopes: ["project", "infra"], run });
  assert.equal(await p.probe(), 1);
  const rows = await p.recallAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "candidate", "listing never promotes a candidate");
});

test("empty banks require no semantic recall or get and are healthy", async () => {
  const run: HindsightRunner = async (_, args) => {
    assert.equal(args[0], "documents");
    return ok({ bank_id: "canary-facts", scope: "project", documents: [], total: 0, total_is_estimate: false });
  };
  const p = new HindsightDurableMemory({ run });
  assert.equal(await p.probe(), 0);
  assert.deepEqual(await p.recallAll(), []);
});

test("listing remains bounded with repeated pages or inflated totals", async () => {
  let lists = 0;
  let gets = 0;
  const run: HindsightRunner = async (_, args) => {
    if (args[0] === "documents") {
      lists++;
      return ok({
        bank_id: "herdr-global",
        scope: "global",
        total: 1000000,
        total_is_estimate: true,
        documents: Array.from({ length: 20 }, (_, i) => item(`mem-${i}`)),
      });
    }
    assert.equal(args[0], "get");
    gets++;
    return ok(record(args[1]!));
  };
  const rows = await new HindsightDurableMemory({ scopes: ["global"], run }).recallAll();
  assert.ok(lists > 0 && lists <= 3);
  assert.ok(gets <= 50);
  assert.equal(rows.length, 20);
});

test("unaddressable, hidden, unknown and personal records are excluded without inventing IDs", async () => {
  const gets: string[] = [];
  const run: HindsightRunner = async (_, args) => {
    if (args[0] === "documents")
      return ok({
        bank_id: "herdr-global",
        scope: "global",
        total: 6,
        total_is_estimate: false,
        documents: [
          item("mem-candidate", "candidate"),
          item("mem-personal"),
          item("mem-hidden", "retracted"),
          item("mem-unknown", "unknown"),
          { document_id: "unaddressable", status: "verified" },
          item("mem-mismatch"),
        ],
      });
    assert.equal(args[0], "get");
    gets.push(args[1]!);
    return ok(
      record(
        args[1]!,
        args[1] === "mem-candidate" ? "candidate" : "verified",
        args[1] === "mem-personal" ? "personal-facts" : args[1] === "mem-mismatch" ? "herdr-infra" : "herdr-global",
      ),
    );
  };
  const rows = await new HindsightDurableMemory({ scopes: ["global"], run }).recallAll();
  assert.deepEqual(
    rows.map((r) => [r.id, r.status]),
    [["mem-candidate", "candidate"]],
  );
  assert.ok(!gets.includes("mem-hidden") && !gets.includes("mem-unknown") && !gets.includes("unaddressable"));
});

test("list/get failures fail open for reads while strict probe does not report false health", async () => {
  const p = new HindsightDurableMemory({ run: async () => ({ exitCode: 1, stdout: '{"error":"unavailable"}' }) });
  assert.deepEqual(await p.recallAll(), []);
  await assert.rejects(p.probe());
});

test("unknown or personal scope options do not silently acquire project access", () => {
  for (const scopes of [["personal"], ["unknown"], []]) {
    assert.throws(() => new HindsightDurableMemory({ scopes }));
  }
});

test("shared enumeration deadline prevents starting more CLI work after its budget", async () => {
  let calls = 0;
  const run: HindsightRunner = async (_, args) => {
    calls++;
    assert.equal(args[0], "documents");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return ok({
      bank_id: "herdr-global",
      scope: "global",
      total: 1,
      total_is_estimate: false,
      documents: [item("mem-one")],
    });
  };
  const rows = await new HindsightDurableMemory({ scopes: ["global"], timeoutMs: 5, run }).recallAll();
  assert.deepEqual(rows, []);
  assert.equal(calls, 1);
});

test("a bank switch between document pages cannot hydrate earlier addresses against the new bank", async () => {
  let gets = 0;
  const run: HindsightRunner = async (_, args) => {
    if (args[0] === "documents") {
      const offset = Number(args[args.indexOf("--offset") + 1]);
      return ok({
        bank_id: offset === 0 ? "alpha-facts" : "beta-facts",
        scope: "project",
        total: 21,
        total_is_estimate: false,
        documents: Array.from({ length: offset === 0 ? 20 : 1 }, (_, i) => item(`mem-${offset + i}`)),
      });
    }
    gets++;
    return ok(record(args[1]!, "verified", "beta-facts"));
  };
  assert.deepEqual(await new HindsightDurableMemory({ run }).recallAll(), []);
  assert.equal(gets, 0);
});

for (const flag of ["offline", "degraded"]) {
  test(`strict readiness refuses ${flag} listing metadata`, async () => {
    const p = new HindsightDurableMemory({
      scopes: ["global"],
      run: async () => ok({ bank_id: "herdr-global", documents: [], total: 0, total_is_estimate: false, [flag]: true }),
    });
    await assert.rejects(p.probe());
  });
}

test("a capped enumeration with an estimated total reports unknown, never an exact saved count", async () => {
  const run: HindsightRunner = async (_, args) => {
    assert.equal(args[0], "documents");
    const limit = Number(args[args.indexOf("--limit") + 1]);
    const offset = Number(args[args.indexOf("--offset") + 1]);
    return ok({
      bank_id: "herdr-global",
      documents: Array.from({ length: limit }, (_, i) => item(`mem-${offset + i}`)),
      total: 100,
      total_is_estimate: true,
    });
  };
  assert.equal(await new HindsightDurableMemory({ scopes: ["global"], run }).probe(), null);
});
