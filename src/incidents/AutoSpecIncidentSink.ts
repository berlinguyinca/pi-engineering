import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedIncident } from "./IncidentController.ts";

export type AutoSpecCommandRunner = (args: readonly string[]) => Promise<string>;

export interface AutoSpecIncidentSinkOptions {
  root?: string;
  run: AutoSpecCommandRunner;
}

interface AutoSpecResult {
  ok?: unknown;
  dry_run?: unknown;
  fingerprint?: unknown;
  debugger_dispatch?: { role?: unknown; dry_run?: unknown };
}

export class AutoSpecIncidentSink {
  private readonly root: string;
  private readonly run: AutoSpecCommandRunner;

  constructor(options: AutoSpecIncidentSinkOptions) {
    this.root = options.root ?? tmpdir();
    this.run = options.run;
  }

  async publish(event: PublishedIncident): Promise<void> {
    const directory = await mkdtemp(join(this.root, "pi-incident-"));
    const eventFile = join(directory, "event.json");
    try {
      await writeFile(eventFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      const output = await this.run([
        "incident",
        "ingest",
        "--repo",
        event.repo,
        "--event-file",
        eventFile,
        "--dry-run",
        "--json",
      ]);
      let result: AutoSpecResult;
      try {
        result = JSON.parse(output) as AutoSpecResult;
      } catch (error) {
        throw new Error(`AutoSpec returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (
        result.ok !== true ||
        result.dry_run !== true ||
        result.fingerprint !== event.fingerprint ||
        result.debugger_dispatch?.role !== "debugger" ||
        result.debugger_dispatch.dry_run !== true
      ) {
        throw new Error("AutoSpec incident ingest acknowledgement was invalid");
      }
    } finally {
      await unlink(eventFile).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    }
  }
}
