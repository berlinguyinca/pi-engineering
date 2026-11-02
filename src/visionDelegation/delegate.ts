/**
 * First vision delegation: hand pasted images to a vision model in a new herdr
 * pane, wait for its result file, and return the analysis as text.
 *
 * Every outcome other than "no images" becomes explicit text; nothing throws
 * out of `handle`, and every failure names the saved image paths so the
 * picture stays reachable. Each request owns `<artifactDir>/<requestId>/` and
 * only ever reads its own result path. A result that lands after a timeout or
 * cancel is left unread; `state.json` records that it was never injected.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type SessionHandoffMessage, buildSessionHandoff } from "../plannerWorker/sessionHandoff.ts";
import type { ProbeResult } from "../resilience/probe.ts";
import type { HerdrCli } from "../runtime/herdr/HerdrCli.ts";
import { chooseVisionModel } from "./chooseModel.ts";
import type { VisionDelegateSettings } from "./config.ts";
import { saveImages } from "./images.ts";
import {
  type SavedImage,
  type VisionRequest,
  type VisionResult,
  buildRequestFile,
  parseResult,
  renderHandback,
  resultPath,
} from "./protocol.ts";
import type { VisionRegistry } from "./registry.ts";
import { VISION_ROLE_PROMPT } from "./rolePrompt.ts";

export type LineageOutcome = "ok" | "partial" | "failed" | "timeout";

export interface LineageEvent {
  phase: "out" | "back";
  requestId: string;
  fromSession: string;
  toSession: string | null;
  fromModel: string;
  toModel: string;
  outcome: LineageOutcome;
}

export interface VisionDelegatorDeps {
  herdr: HerdrCli;
  settings: VisionDelegateSettings;
  models: Array<{ provider: string; id: string; input?: string[] }>;
  probeFor: (m: { provider: string; id: string }) => Promise<ProbeResult>;
  registry: VisionRegistry;
  artifactDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  lineage?: (e: LineageEvent) => void;
  /** Id of the current text model (lineage `fromModel`). */
  textModel: string;
  /** Pane the vision pane splits from (the caller's HERDR_PANE_ID). Absent means herdr is unavailable. */
  originPaneId?: string;
}

export interface VisionDelegateInput {
  sessionId: string;
  cwd: string;
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  messages: SessionHandoffMessage[];
  signal?: AbortSignal;
  status?: (text: string | undefined) => void;
}

export type VisionDelegateOutput = { action: "continue" } | { action: "transform"; text: string; images: [] };

type RequestState = "waiting" | "done" | "failed" | "timed_out" | "cancelled";

type WaitOutcome =
  | { kind: "result"; result: VisionResult }
  | { kind: "invalid"; reason: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

const POLL_MS = 500;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class VisionDelegator {
  private readonly deps: VisionDelegatorDeps;

  constructor(deps: VisionDelegatorDeps) {
    this.deps = deps;
  }

  async handle(input: VisionDelegateInput): Promise<VisionDelegateOutput> {
    if (input.images.length === 0) return { action: "continue" };
    let requestId: string;
    let reqDir: string;
    try {
      requestId = this.deps.newId();
      reqDir = join(this.deps.artifactDir, requestId);
      resultPath(reqDir, requestId); // rejects unsafe ids before anything is written
    } catch (err) {
      return this.failure(input, [], `could not create a request id (${errText(err)})`);
    }

    let images: SavedImage[];
    try {
      images = await saveImages(input.images, reqDir);
    } catch (err) {
      return this.failure(input, [], `the image(s) could not be saved (${errText(err)})`);
    }

    const { herdr, originPaneId } = this.deps;
    if (!herdr.splitPane || !originPaneId) {
      const why = !herdr.splitPane
        ? "this herdr client cannot split panes"
        : "this session is not running in a herdr pane";
      return this.failure(input, images, `herdr is unavailable (${why})`);
    }

    let model: { provider: string; id: string };
    try {
      const chosen = await chooseVisionModel({
        models: this.deps.models,
        preference: this.deps.settings.aliasPreference,
        probeFor: this.deps.probeFor,
      });
      if ("none" in chosen) return this.failure(input, images, `no vision model was available.\n${chosen.reason}`);
      model = chosen;
    } catch (err) {
      return this.failure(input, images, `no vision model was available (${errText(err)})`);
    }

    const agentName = `vision-${input.sessionId.slice(0, 8)}`;
    const request: VisionRequest = {
      requestId,
      sessionId: input.sessionId,
      userText: input.text,
      images,
      createdAt: new Date(this.deps.now()).toISOString(),
    };
    const lineage = (phase: "out" | "back", outcome: LineageOutcome) =>
      this.emit({
        phase,
        requestId,
        fromSession: input.sessionId,
        toSession: agentName,
        fromModel: this.deps.textModel,
        toModel: `${model.provider}/${model.id}`,
        outcome,
      });

    let paneId: string;
    try {
      await this.writeRequestFiles(reqDir, request, input);
      await this.writeState(reqDir, requestId, "waiting");
      lineage("out", "ok");
      paneId = (await herdr.splitPane({ paneId: originPaneId, cwd: input.cwd, direction: "right" })).paneId;
      await herdr.startAgent(paneId, "pi", agentName, [
        "--provider",
        model.provider,
        "--model",
        model.id,
        "--append-system-prompt",
        join(reqDir, "role-prompt.md"),
        `@${join(reqDir, "instructions.md")}`,
        `@${join(reqDir, "handoff.md")}`,
        ...images.map((i) => `@${i.path}`),
      ]);
    } catch (err) {
      lineage("back", "failed");
      await this.writeState(reqDir, requestId, "failed", errText(err));
      return this.failure(input, images, `starting the vision pane failed (${errText(err)})`);
    }

    input.status?.("analyzing image…");
    let outcome: WaitOutcome;
    try {
      outcome = await this.waitForResult(reqDir, request, input.signal);
    } catch (err) {
      outcome = { kind: "invalid", reason: errText(err) };
    } finally {
      input.status?.(undefined);
    }

    if (outcome.kind === "result") {
      const { result } = outcome;
      lineage("back", result.status);
      await this.writeState(reqDir, requestId, "done", undefined, result.status);
      try {
        this.deps.registry.set(input.sessionId, {
          paneId,
          agentName,
          sessionDir: reqDir,
          startedAt: request.createdAt,
        });
      } catch {
        // Registry failure only costs reuse later; the analysis is still delivered.
      }
      return { action: "transform", text: renderHandback(input.text, result, model.id, images), images: [] };
    }
    if (outcome.kind === "timeout") {
      lineage("back", "timeout");
      await this.writeState(reqDir, requestId, "timed_out");
      return this.failure(
        input,
        images,
        `the analysis timed out after ${this.deps.settings.waitSeconds} seconds (vision model ${model.id})`,
      );
    }
    if (outcome.kind === "cancelled") {
      lineage("back", "failed");
      await this.writeState(reqDir, requestId, "cancelled");
      return this.failure(input, images, "the delegation was cancelled before the vision model answered");
    }
    lineage("back", "failed");
    await this.writeState(reqDir, requestId, "failed", outcome.reason);
    return this.failure(input, images, `the vision result was rejected and the delegation failed (${outcome.reason})`);
  }

  private async waitForResult(reqDir: string, request: VisionRequest, signal?: AbortSignal): Promise<WaitOutcome> {
    const file = resultPath(reqDir, request.requestId);
    const deadline = this.deps.now() + this.deps.settings.waitSeconds * 1000;
    for (;;) {
      if (signal?.aborted) return { kind: "cancelled" };
      const seen = await readResult(file);
      if (seen !== undefined && isRecord(seen) && seen.request_id === request.requestId) {
        const parsed = parseResult(seen, request);
        return parsed.ok ? { kind: "result", result: parsed.result } : { kind: "invalid", reason: parsed.reason };
      }
      // Missing, half-written, unparseable, or for another request: keep waiting.
      if (this.deps.now() >= deadline) return { kind: "timeout" };
      await this.deps.sleep(POLL_MS);
    }
  }

  private async writeRequestFiles(reqDir: string, request: VisionRequest, input: VisionDelegateInput): Promise<void> {
    const handoff = buildSessionHandoff({ sessionId: input.sessionId, messages: input.messages });
    const ask = input.text.trim() ? input.text : "(The user sent the image(s) with no accompanying text.)";
    const handoffText = handoff.ok
      ? `${handoff.rendered}\n\n## The user's message with the image(s)\n\n${ask}\n`
      : `Note: no session context was available (${handoff.error}).\n\n## The user's message with the image(s)\n\n${ask}\n`;
    const result = resultPath(reqDir, request.requestId);
    const instructions = [
      "# Vision request",
      "",
      `Request id: ${request.requestId}`,
      `Request file: ${join(reqDir, "request.json")}`,
      `Result file (write here, via a temporary file and rename): ${result}`,
      "",
      "Read request.json for the image paths and sha256 hashes. Copy them back exactly in the result.",
      "",
      "Images:",
      ...request.images.map((i) => `- ${i.path} (sha256 ${i.sha256})`),
      "",
    ].join("\n");
    await mkdir(join(reqDir, "results"), { recursive: true });
    await atomicWrite(join(reqDir, "handoff.md"), handoffText);
    await atomicWrite(join(reqDir, "request.json"), buildRequestFile(request));
    await atomicWrite(join(reqDir, "instructions.md"), instructions);
    await atomicWrite(join(reqDir, "role-prompt.md"), VISION_ROLE_PROMPT);
  }

  private async writeState(
    reqDir: string,
    requestId: string,
    status: RequestState,
    reason?: string,
    resultStatus?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      request_id: requestId,
      status,
      injected: status === "done",
      updated_at: new Date(this.deps.now()).toISOString(),
    };
    if (reason !== undefined) body.reason = reason;
    if (resultStatus !== undefined) body.result_status = resultStatus;
    try {
      await atomicWrite(join(reqDir, "state.json"), `${JSON.stringify(body, null, 2)}\n`);
    } catch {
      // state.json is a record, not a gate; failing to write it never changes the answer.
    }
  }

  private emit(e: LineageEvent): void {
    try {
      this.deps.lineage?.(e);
    } catch {
      // A broken lineage sink must never break the delegation.
    }
  }

  private failure(input: VisionDelegateInput, images: SavedImage[], why: string): VisionDelegateOutput {
    const n = input.images.length;
    const ask = input.text.trim();
    const lines = [
      ask
        ? `The user attached ${n} image(s) with this message: ${ask}`
        : `The user attached ${n} image(s) with no accompanying text.`,
      "You cannot see the image(s), and no vision analysis is available.",
      `Vision delegation did not complete: ${why}`,
    ];
    if (images.length > 0) {
      lines.push(
        "The image(s) are saved here; tell the user, who can paste them again or open them:",
        ...images.map((i) => `- ${i.path} (${i.mimeType})`),
      );
    } else {
      lines.push("The image(s) could not be saved to disk; ask the user to paste them again.");
    }
    return { action: "transform", text: lines.join("\n"), images: [] };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readResult(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
