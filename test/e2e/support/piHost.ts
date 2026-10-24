/**
 * A Pi "host" for acceptance tests: its own global engineering.yaml (the `herdr:` block), key file (0600), state dir,
 * and a lineage emitter built by the REAL loader (loadLineageEmitter). Two hosts = two keys + two sources.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineageEmitter } from "../../../src/runtime/herdr/lineage.ts";
import { loadLineageEmitter } from "../../../src/runtime/herdr/lineageConfig.ts";
import type { Plane } from "./plane.ts";

export interface PiHostOptions {
  /** label of the plane key this host uses */
  key: string;
  instanceId: string;
  roomId: string;
  workspaceId?: string;
  missionId?: string;
  visibility?: "private" | "mission" | "room" | "org";
}

export interface PiHost {
  agentDir: string;
  stateDir: string;
  emitter: LineageEmitter;
  /** wait until the lineage outbox is drained */
  drain(): Promise<void>;
}

export async function startPiHost(plane: Plane, o: PiHostOptions): Promise<PiHost> {
  const root = mkdtempSync(join(tmpdir(), `t16-pihost-${o.instanceId}-`));
  const agentDir = join(root, "agent");
  const stateDir = join(root, "state");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const keyFile = join(root, "ingest.key");
  writeFileSync(keyFile, `${plane.keys[o.key]}\n`);
  chmodSync(keyFile, 0o600);
  const lines = [
    "herdr:",
    `  url: ${plane.url}`,
    `  api_key_file: ${keyFile}`,
    `  instance_id: ${o.instanceId}`,
    "  lineage: true",
    `  visibility: ${o.visibility ?? "room"}`,
    `  room_id: ${o.roomId}`,
    ...(o.workspaceId ? [`  workspace_id: ${o.workspaceId}`] : []),
    ...(o.missionId ? [`  mission_id: ${o.missionId}`] : []),
  ];
  writeFileSync(join(agentDir, "engineering.yaml"), `${lines.join("\n")}\n`);
  const notes: string[] = [];
  const emitter = await loadLineageEmitter({
    agentDir,
    envelopeDir: join(stateDir, "control-plane"),
    log: (l) => notes.push(l),
  });
  if (!emitter) throw new Error(`loadLineageEmitter returned null: ${notes.join("; ")}`);
  return {
    agentDir,
    stateDir,
    emitter,
    async drain() {
      await emitter.idle();
    },
  };
}
