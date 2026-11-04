import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../../src/ledger/Ledger.ts";

const writer = join(import.meta.dirname, "..", "support", "planWriter.ts");

interface Child {
  ready: Promise<void>;
  done: Promise<(string | null)[]>;
}

/** Spawns a plan writer; `ready` resolves when its ledger is open, `done` when it has exited and drained stdout. */
function child(file: string, wi: string, go: string, rounds: string[]): Child {
  const p = spawn(process.execPath, [writer, file, wi, go, ...rounds], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  let onReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    onReady = r;
  });
  p.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    if (out.includes("ready\n")) onReady();
  });
  const done = new Promise<(string | null)[]>((resolve, reject) => {
    // "close", not "exit": "exit" can fire before the last stdout chunk is read.
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`planWriter exited ${code}`));
      const last = out.trim().split("\n").at(-1) ?? "[]";
      resolve(JSON.parse(last) as (string | null)[]);
    });
  });
  return { ready, done };
}

async function race(rounds: string[][]): Promise<{ file: string; wi: string; results: (string | null)[][] }> {
  const dir = mkdtempSync(join(tmpdir(), "pi-eng-plan-race-"));
  try {
    const file = join(dir, "ledger.jsonl");
    const go = join(dir, "go");
    const seed = await Ledger.create(file);
    const wi = (await seed.createWorkItem("goal", "low", ["."], { type: "system" })).id;
    const kids = rounds.map((r) => child(file, wi, go, r));
    await Promise.all(kids.map((k) => k.ready));
    writeFileSync(go, "go");
    const results = await Promise.all(kids.map((k) => k.done));
    const events = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    return { file: JSON.stringify(events), wi, results };
  } finally {
    // Keep the log text (returned above) and drop the directory.
    rmSync(dir, { recursive: true, force: true });
  }
}

type Rec = { type: string; payload: { plan_id?: string; revision?: number; supersedes?: string } };
const planEvents = (log: string): Rec[] =>
  (JSON.parse(log) as string[]).map((l) => JSON.parse(l) as Rec).filter((e) => e.type === "plan.recorded");

test("processes recording different plans for one work item never share a revision", async () => {
  const { file, wi, results } = await race(
    [0, 1, 2, 3].map((i) => [`distinct:a${i}`, `distinct:b${i}`, `distinct:c${i}`]),
  );
  const events = planEvents(file);
  assert.equal(events.length, 12, "every distinct plan is recorded exactly once");
  assert.deepEqual(
    events.map((e) => e.payload.revision),
    Array.from({ length: 12 }, (_, i) => i + 1),
    "revisions are unique and monotonic in log order",
  );
  assert.deepEqual(
    events.map((e) => e.payload.plan_id),
    Array.from({ length: 12 }, (_, i) => `${wi}/${i + 1}`),
  );
  events.forEach((e, i) => assert.equal(e.payload.supersedes, i === 0 ? undefined : `${wi}/${i}`));
  const returned = results.flat().filter((id): id is string => id !== null);
  assert.equal(new Set(returned).size, 12, "no two callers were handed the same plan id");
});

test("processes re-recording the same plan write it once", async () => {
  const { file, wi, results } = await race([0, 1, 2].map(() => ["same:x", "same:x"]));
  const events = planEvents(file);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.revision, 1);
  assert.deepEqual(new Set(results.flat()), new Set([`${wi}/1`]));
});
