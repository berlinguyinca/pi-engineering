/**
 * Delivering one request to a vision pane over herdr: either split a new pane
 * and start a `pi` agent on the vision model with the request files as `@file`
 * arguments, or prompt an already-registered agent (by name) with file paths only.
 * Both resolve with the pane id once delivery is submitted; the result file,
 * not herdr state, says when the analysis is done.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { HerdrCli } from "../runtime/herdr/HerdrCli.ts";
import type { SavedImage, VisionRequest } from "./protocol.ts";
import { reusePrompt } from "./requestFiles.ts";

/** `agent prompt` only submits (the result file is the completion signal), so this is short. */
const PROMPT_TIMEOUT_MS = 30_000;

/** `vision-<session8>-<request8>`, lowercased, [a-z0-9-] only, at most 32 chars (R9). */
export function visionAgentName(sessionId: string, requestId: string): string {
  return `vision-${sessionId.slice(0, 8)}-${requestId.slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 32);
}

export interface NewPaneSpec {
  originPaneId: string;
  cwd: string;
  reqDir: string;
  sessionDir: string;
  agentName: string;
  model: { provider: string; id: string };
  images: SavedImage[];
}

/** Splits a pane and starts the vision agent; `onPane` runs as soon as the pane exists (before the start). */
export async function startNewPane(
  herdr: HerdrCli,
  split: NonNullable<HerdrCli["splitPane"]>,
  o: NewPaneSpec,
  onPane: (paneId: string) => Promise<void>,
): Promise<string> {
  await mkdir(o.sessionDir, { recursive: true });
  const { paneId } = await split({ paneId: o.originPaneId, cwd: o.cwd, direction: "right" });
  await onPane(paneId);
  await herdr.startAgent(paneId, "pi", o.agentName, [
    "--provider",
    o.model.provider,
    "--model",
    o.model.id,
    "--session-dir",
    o.sessionDir,
    "--append-system-prompt",
    join(o.reqDir, "role-prompt.md"),
    `@${join(o.reqDir, "instructions.md")}`,
    `@${join(o.reqDir, "handoff.md")}`,
    ...o.images.map((i) => `@${i.path}`),
  ]);
  return paneId;
}

/**
 * Hands the request to the registered vision agent with file paths only. It is addressed by its unique
 * agent NAME, never by bare pane id (R22): a pane id can be reused by another agent after a restart.
 * The caller must already have confirmed that `agentName` answers from `paneId` in this same call.
 */
export async function promptReusedPane(
  herdr: HerdrCli,
  agentName: string,
  paneId: string,
  reqDir: string,
  request: VisionRequest,
): Promise<string> {
  await herdr.prompt(agentName, reusePrompt(reqDir, request), PROMPT_TIMEOUT_MS);
  return paneId;
}
