#!/usr/bin/env node
/**
 * Vision delegation acceptance spike: runs the REAL stack on this machine.
 * Real `RealHerdrCli`, a real `VisionDelegator`, and the live gateway model;
 * only the lineage emitter is a recording fake (nothing is sent to a control
 * plane) and the registry and request files live in a temp directory.
 *
 * Phases:
 *   a. first image (left half red, right half blue): a new vision pane, an
 *      `ok` handback that names both colours, lineage out/back;
 *   b. second image (green square on white) in the same session: the SAME pane
 *      is prompted (no second `startAgent`) and the handback describes it;
 *   c. error path: a delegator pointed at a model id the gateway does not
 *      serve (probe bypassed): Pi errors and sits idle, and the delegation
 *      fails as "the vision agent stopped without writing a result" well
 *      before its wait_seconds (R26); its pane is closed;
 *   c2. error path: a provider Pi does not know (probe bypassed): Pi exits,
 *      and the delegation fails at once with "the vision pane exited" (R21);
 *   d. dead pane: the vision pane from a/b is closed by hand, then a third
 *      image in the same session starts a NEW vision session, the handback
 *      says earlier images are gone, and the registry points at the new pane.
 *
 * Safety: one throwaway herdr workspace (created with --no-focus, its root
 * pane is the origin pane) is closed in `finally`, even on failure. No user
 * pane or workspace is touched. `~/.pi/agent/models.json` is read READ-ONLY
 * for the vision model's provider/id/input and, for the gateway probe, its
 * baseUrl and key, which are never printed. Test images are generated here.
 *
 *   node scripts/vision-delegation-spike.ts [--model <id>] [--probe listed|catalog] [--wait <seconds>] [--skip c,c2,d] [--keep]
 *
 * --model  vision model id under provider `metabolomics` (default: the image
 *          model listed in models.json). An id that models.json does not list
 *          is declared text+image here and Pi runs it as a custom model id; the
 *          script says so. The gateway probe still decides whether it is served.
 * --probe  `listed` (default): healthy when GET /models answers 200 and lists
 *          the model; `catalog`: the production CatalogRecoveryProbe, which
 *          also needs a fresh admission report for the model. Both run; this
 *          picks the one the delegator uses.
 * --wait   wait_seconds for phases a/b (default 300)
 * --skip   comma list of phases to skip (c, c2, d)
 * --keep   keep the temp directory (request files, state.json) for inspection
 *
 * Exit 0 when every check passes.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

import { defaultModelsPath } from "../src/models/modelsConfig.ts";
import { CatalogRecoveryProbe, type ProbeResult } from "../src/resilience/probe.ts";
import { type HerdrAgent, RealHerdrCli } from "../src/runtime/herdr/HerdrCli.ts";
import type { HandoffLineageInput, LineageEmitter } from "../src/runtime/herdr/lineage.ts";
import type { VisionDelegateSettings } from "../src/visionDelegation/config.ts";
import { VisionDelegator } from "../src/visionDelegation/delegate.ts";
import { makeVisionLineageHook } from "../src/visionDelegation/lineage.ts";
import { VisionRegistry } from "../src/visionDelegation/registry.ts";
import type { VisionDelegateOutput } from "../src/visionDelegation/types.ts";

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const waitSeconds = Number(flag("--wait") ?? 300);
const skip = new Set((flag("--skip") ?? "").split(",").filter(Boolean));
const keep = argv.includes("--keep");

const VISION_MODEL_ID = flag("--model") ?? "qwen3.8-27b-modality-vision-quant-q8_k_xl";
const VISION_PROVIDER = "metabolomics";
const BAD_MODEL_ID = "no-such-vision-model-spike";
const BAD_PROVIDER = "no-such-provider-spike";
const ERROR_WAIT_SECONDS = 45;
/** Phase c's wait: long enough that an R26 idle stop (about 30 s) is clearly not the deadline. */
const IDLE_WAIT_SECONDS = 120;

const t0 = Date.now();
const stamp = (): string => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a: unknown[]): void => console.log(stamp(), ...a);
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`${stamp()}   ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

// ---------------------------------------------------------------------------
// PNG generation (RGB, 8 bit, no filter), so no user file is ever used.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
type Rgb = [number, number, number];
function png(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const RED_BLUE = png(256, 128, (x) => (x < 128 ? [220, 20, 20] : [20, 40, 220]));
const GREEN_ON_WHITE = png(256, 256, (x, y) =>
  x >= 80 && x < 176 && y >= 80 && y < 176 ? [20, 170, 40] : [255, 255, 255],
);
const YELLOW = png(128, 128, () => [240, 220, 20]);
const image = (b: Buffer) => [{ data: b.toString("base64"), mimeType: "image/png" }];

// ---------------------------------------------------------------------------
// The real herdr client, recording the calls the delegator makes.

interface Call {
  at: string;
  op: string;
  target: string;
  detail?: string;
}
class RecordingHerdr extends RealHerdrCli {
  readonly calls: Call[] = [];
  override async splitPane(o: Parameters<RealHerdrCli["splitPane"]>[0]): Promise<{ paneId: string }> {
    const r = await super.splitPane(o);
    this.calls.push({ at: stamp(), op: "splitPane", target: o.paneId, detail: `-> ${r.paneId}` });
    return r;
  }
  override async startAgent(paneId: string, kind: string, name: string, args: readonly string[] = []): Promise<void> {
    const started = Date.now();
    this.calls.push({
      at: stamp(),
      op: "startAgent",
      target: paneId,
      detail: `${name} --kind ${kind} -- ${args.join(" ")}`,
    });
    try {
      await super.startAgent(paneId, kind, name, args);
      log(`  startAgent returned after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      log(`  startAgent threw after ${((Date.now() - started) / 1000).toFixed(1)}s: ${(err as Error).message}`);
      throw err;
    }
  }
  override async prompt(target: string, text: string, timeoutMs?: number): Promise<void> {
    // Acceptance item from the Task 7 review: is the agent ever still `working` when prompted?
    const before = await super.getAgent(target).catch((e: Error) => `error: ${e.message}`);
    const status = typeof before === "string" ? before : (before?.agent_status ?? "null");
    this.calls.push({ at: stamp(), op: "prompt", target, detail: `agent_status before prompt: ${status}` });
    await super.prompt(target, text, timeoutMs);
  }
  override async closePane(target: string): Promise<void> {
    this.calls.push({ at: stamp(), op: "closePane", target });
    await super.closePane(target);
  }
  override async getAgent(target: string): Promise<HerdrAgent | null> {
    try {
      return await super.getAgent(target);
    } catch (err) {
      this.calls.push({ at: stamp(), op: "getAgent threw", target, detail: (err as Error).message });
      throw err;
    }
  }
  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

// ---------------------------------------------------------------------------

interface ModelsJson {
  providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: Array<{ id: string; input?: string[] }> }>;
}

function readVisionModel(): {
  model: { provider: string; id: string; input: string[] };
  baseUrl?: string;
  apiKey?: string;
} {
  const cfg = JSON.parse(readFileSync(defaultModelsPath(), "utf8")) as ModelsJson;
  const provider = cfg.providers?.[VISION_PROVIDER];
  if (!provider) throw new Error(`provider ${VISION_PROVIDER} is not in models.json`);
  const entry = provider.models?.find((m) => m.id === VISION_MODEL_ID);
  if (entry && !entry.input?.includes("image"))
    throw new Error(`${VISION_MODEL_ID} does not accept images in models.json`);
  if (!entry) {
    console.log(
      `NOTE: ${VISION_PROVIDER}/${VISION_MODEL_ID} is not listed in models.json; declared text+image here, Pi runs it as a custom model id`,
    );
  }
  // A literal key only; an env-var name or `!command` is not resolved here (the probe then reports unauthorized).
  return {
    model: {
      provider: VISION_PROVIDER,
      id: VISION_MODEL_ID,
      input: entry?.input ? [...entry.input] : ["text", "image"],
    },
    baseUrl: provider?.baseUrl,
    apiKey: provider?.apiKey,
  };
}

function settings(seconds: number): VisionDelegateSettings {
  return { enabled: true, waitSeconds: seconds, aliasPreference: ["qwen3.8-vision"], notes: [] };
}

function printOutcome(label: string, out: VisionDelegateOutput): string {
  const text = out.action === "transform" ? out.text : "(continue)";
  console.log(`----- ${label}: handback (${out.action}) -----\n${text}\n----- end ${label} -----`);
  return text;
}

function printState(artifactDir: string): void {
  for (const id of readdirSync(artifactDir)) {
    try {
      console.log(`state.json ${id}: ${readFileSync(join(artifactDir, id, "state.json"), "utf8").trim()}`);
    } catch {
      console.log(`state.json ${id}: (none)`);
    }
  }
}

async function main(): Promise<void> {
  const { model, baseUrl, apiKey } = readVisionModel();
  log(`vision model from models.json: ${model.provider}/${model.id} input=${model.input.join("+")}`);
  log(
    `herdr: ${(await exec("herdr", ["--version"])).stdout.trim()}; pi: ${(await exec("pi", ["--version"])).stdout.trim()}`,
  );

  const probe = new CatalogRecoveryProbe({
    timeoutMs: 15_000,
    resolve: async () =>
      baseUrl ? { baseUrl, ...(apiKey ? { apiKey } : {}), modelId: model.id, provider: model.provider } : undefined,
  });
  const catalog: ProbeResult = await probe.probe();
  log(`production probe (CatalogRecoveryProbe: /models + admission report): ${JSON.stringify(catalog)}`);
  // The simple probe: the gateway answers GET /models with 200 and lists the model. The key is never printed.
  const listed = async (): Promise<ProbeResult> => {
    if (!baseUrl) return { healthy: false, authoritative: true, reason: "no baseUrl in models.json" };
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { healthy: false, authoritative: true, reason: `gateway /models answered ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return body.data?.some((r) => r.id === model.id)
      ? { healthy: true, authoritative: true }
      : { healthy: false, authoritative: true, reason: `model ${model.id} is not listed` };
  };
  const useCatalog = flag("--probe") === "catalog";
  const probeFor = useCatalog ? () => probe.probe() : listed;
  const gateway = await probeFor();
  log(`probe used (${useCatalog ? "catalog" : "listed"}): ${JSON.stringify(gateway)}`);
  check(gateway.healthy && gateway.authoritative !== false, "the live gateway answers and lists the vision model");

  const root = realpathSync(mkdtempSync(join(tmpdir(), "vision-spike-")));
  const project = join(root, "project");
  const artifactDir = join(root, "requests");
  const registryFile = join(root, "registry.json");
  writeFileSync(join(root, "red-blue.png"), RED_BLUE);
  writeFileSync(join(root, "green-on-white.png"), GREEN_ON_WHITE);
  rmSync(project, { recursive: true, force: true });
  await exec("mkdir", ["-p", project]);
  log(`temp root: ${root}`);

  const herdr = new RecordingHerdr();
  const ws = await herdr.createWorkspace(project);
  log(`throwaway workspace ${ws.workspaceId}, origin (root) pane ${ws.paneId}`);

  const lineage: HandoffLineageInput[] = [];
  const emitter = { handoff: (h: HandoffLineageInput) => lineage.push(h) } as unknown as LineageEmitter;
  const registry = new VisionRegistry(registryFile);
  const base = {
    herdr,
    registry,
    artifactDir,
    now: Date.now,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    newId: () => randomUUID(),
    lineage: makeVisionLineageHook(emitter),
    textModel: "metabolomics/spike-text-model",
    originPaneId: ws.paneId,
  };
  const status = (label: string) => (t: string | undefined) => log(`  [status ${label}] ${t ?? "(cleared)"}`);

  try {
    const delegator = new VisionDelegator({
      ...base,
      settings: settings(waitSeconds),
      models: [model],
      probeFor,
    });
    const sessionId = randomUUID();
    log(`session ${sessionId}`);

    // (a) first image ----------------------------------------------------------
    log("phase a: first image (left half red, right half blue)");
    let started = Date.now();
    const outA = await delegator.handle({
      sessionId,
      cwd: project,
      text: "What colours are the left half and the right half of this image?",
      images: image(RED_BLUE),
      messages: [],
      status: status("a"),
    });
    log(`phase a took ${((Date.now() - started) / 1000).toFixed(1)}s`);
    const textA = printOutcome("a", outA);
    const entryA = registry.get(sessionId);
    log(`registry entry: ${JSON.stringify(entryA)}`);
    check(/STATUS: ok\./.test(textA), "a: handback status ok");
    check(/red/i.test(textA) && /blue/i.test(textA), "a: handback names red and blue");
    check(/left[^\n]*red|red[^\n]*left/i.test(textA), "a: handback ties red to the left half");
    check(herdr.count("startAgent") === 1, "a: one startAgent");
    check(!!entryA?.paneId, "a: session registered with a pane");

    // (b) second image, same session: reuse ------------------------------------
    log("phase b: second image (green square on white), same session");
    started = Date.now();
    const outB = await delegator.handle({
      sessionId,
      cwd: project,
      text: "Here is another image. What shape and colours does it show?",
      images: image(GREEN_ON_WHITE),
      messages: [],
      status: status("b"),
    });
    log(`phase b took ${((Date.now() - started) / 1000).toFixed(1)}s`);
    const textB = printOutcome("b", outB);
    const entryB = registry.get(sessionId);
    check(/STATUS: ok\./.test(textB), "b: handback status ok");
    check(/green/i.test(textB) && /white/i.test(textB), "b: handback describes the green square on white");
    check(/square/i.test(textB), "b: handback names a square");
    check(herdr.count("startAgent") === 1, "b: still one startAgent (no second start)");
    check(herdr.count("prompt") === 1, "b: the reused pane was prompted once");
    const promptB = herdr.calls.find((c) => c.op === "prompt");
    check(promptB?.target === entryA?.agentName, `b: prompted by agent name (${promptB?.target}), not pane id (R22)`);
    check(entryB?.paneId === entryA?.paneId, `b: same pane id (${entryA?.paneId})`);

    // (c) error path: a model the gateway does not serve ----------------------
    if (!skip.has("c")) {
      log(`phase c: delegator pointed at ${VISION_PROVIDER}/${BAD_MODEL_ID} (probe bypassed)`);
      const startsBefore = herdr.count("startAgent");
      const bad = new VisionDelegator({
        ...base,
        registry: new VisionRegistry(join(root, "registry-c.json")),
        settings: settings(IDLE_WAIT_SECONDS),
        models: [{ provider: VISION_PROVIDER, id: BAD_MODEL_ID, input: ["text", "image"] }],
        probeFor: async () => ({ healthy: true, authoritative: true }),
      });
      started = Date.now();
      const outC = await bad.handle({
        sessionId: randomUUID(),
        cwd: project,
        text: "What colours are in this image?",
        images: image(RED_BLUE),
        messages: [],
        status: status("c"),
      });
      const tookC = (Date.now() - started) / 1000;
      log(`phase c took ${tookC.toFixed(1)}s`);
      const textC = printOutcome("c", outC);
      check(/Vision delegation did not complete/.test(textC), "c: explicit 'did not complete' handback");
      check(/the vision agent stopped without writing a result/.test(textC), "c: says the vision agent stopped (R26)");
      check(tookC < IDLE_WAIT_SECONDS / 2, `c: failed well before the ${IDLE_WAIT_SECONDS}s deadline`);
      const startCall = herdr.calls.filter((c) => c.op === "startAgent")[startsBefore];
      const badPane = startCall?.target;
      check(!!badPane, "c: a vision pane was started for the bad model");
      if (badPane) {
        check(
          herdr.calls.some((c) => c.op === "closePane" && c.target === badPane),
          `c: closePane(${badPane}) called`,
        );
        const panes = (await exec("herdr", ["pane", "list", "--workspace", ws.workspaceId])).stdout;
        check(!panes.includes(`"${badPane}"`), `c: pane ${badPane} no longer listed`);
      }
    }

    // (c2) error path: a provider Pi does not know ----------------------------
    if (!skip.has("c2")) {
      log(`phase c2: delegator pointed at ${BAD_PROVIDER}/${BAD_MODEL_ID} (probe bypassed)`);
      const startsBefore = herdr.count("startAgent");
      const bad = new VisionDelegator({
        ...base,
        registry: new VisionRegistry(join(root, "registry-c2.json")),
        settings: settings(ERROR_WAIT_SECONDS),
        models: [{ provider: BAD_PROVIDER, id: BAD_MODEL_ID, input: ["text", "image"] }],
        probeFor: async () => ({ healthy: true, authoritative: true }),
      });
      started = Date.now();
      const outC2 = await bad.handle({
        sessionId: randomUUID(),
        cwd: project,
        text: "What colours are in this image?",
        images: image(RED_BLUE),
        messages: [],
        status: status("c2"),
      });
      const tookC2 = (Date.now() - started) / 1000;
      log(`phase c2 took ${tookC2.toFixed(1)}s`);
      const textC2 = printOutcome("c2", outC2);
      check(/Vision delegation did not complete/.test(textC2), "c2: explicit 'did not complete' handback");
      // R21: herdr's agent_not_found reads as "gone", so the exit is noticed at once, not at the deadline.
      check(/the vision pane exited before writing a result/.test(textC2), "c2: says the vision pane exited");
      check(tookC2 < ERROR_WAIT_SECONDS - 15, `c2: failed well before the ${ERROR_WAIT_SECONDS}s deadline`);
      const badPane = herdr.calls.filter((c) => c.op === "startAgent")[startsBefore]?.target;
      if (badPane) {
        const panes = (await exec("herdr", ["pane", "list", "--workspace", ws.workspaceId])).stdout;
        check(!panes.includes(`"${badPane}"`), `c2: pane ${badPane} no longer listed`);
      }
    }

    // (d) dead pane: close the reused pane, then send a third image -----------
    if (!skip.has("d") && entryB?.paneId) {
      log(`phase d: closing vision pane ${entryB.paneId} by hand, then a third image (yellow square)`);
      await exec("herdr", ["pane", "close", entryB.paneId]);
      const startsBeforeD = herdr.count("startAgent");
      started = Date.now();
      const outD = await delegator.handle({
        sessionId,
        cwd: project,
        text: "One more: what colour is this?",
        images: image(YELLOW),
        messages: [],
        status: status("d"),
      });
      log(`phase d took ${((Date.now() - started) / 1000).toFixed(1)}s`);
      const textD = printOutcome("d", outD);
      const entryD = registry.get(sessionId);
      log(`registry entry after d: ${JSON.stringify(entryD ?? null)}`);
      // R21: the stale entry is dropped and a NEW vision session analyses the image, with the restart note.
      check(/STATUS: ok\./.test(textD), "d: handback status ok (a new vision session)");
      check(/yellow/i.test(textD), "d: handback names yellow");
      check(/no longer in the vision session's context/.test(textD), "d: handback says earlier images are gone");
      check(herdr.count("startAgent") === startsBeforeD + 1, "d: exactly one new startAgent");
      check(!!entryD && entryD.paneId !== entryB.paneId, `d: registry now points at a new pane (${entryD?.paneId})`);
    }
  } finally {
    console.log("----- herdr calls made by the delegator -----");
    for (const c of herdr.calls) console.log(`${c.at} ${c.op} ${c.target}${c.detail ? ` ${c.detail}` : ""}`);
    console.log("----- recorded lineage handoffs (fake emitter; nothing sent) -----");
    for (const h of lineage) console.log(JSON.stringify(h));
    try {
      printState(artifactDir);
    } catch {
      // no request directory
    }
    try {
      await exec("herdr", ["workspace", "close", ws.workspaceId]);
      log(`closed workspace ${ws.workspaceId}`);
    } catch (err) {
      log(`WARNING: could not close workspace ${ws.workspaceId}: ${(err as Error).message}`);
    }
    if (keep) log(`kept ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }

  const outs = lineage.filter((h) => h.cause === "vision_delegate").length;
  const backs = lineage.filter((h) => h.cause === "vision_return").length;
  check(outs >= 2 && backs >= 2, `lineage: ${outs} vision_delegate and ${backs} vision_return events recorded`);
  console.log(failures.length ? `FAILED (${failures.length}): ${failures.join("; ")}` : "ALL CHECKS PASSED");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
