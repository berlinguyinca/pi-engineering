/**
 * Persisted map from an original session id to its open vision pane.
 *
 * A JSON file written via temp file and rename, so a crash never leaves a
 * half-written registry. A missing or corrupt file reads as empty and never
 * throws; `set` replaces only that session's entry.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RegistryEntry {
  paneId: string;
  agentName: string;
  sessionDir: string;
  startedAt: string;
}

function isEntry(v: unknown): v is RegistryEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.paneId === "string" &&
    typeof e.agentName === "string" &&
    typeof e.sessionDir === "string" &&
    typeof e.startedAt === "string"
  );
}

export class VisionRegistry {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get(sessionId: string): RegistryEntry | undefined {
    return this.read().get(sessionId);
  }

  set(sessionId: string, entry: RegistryEntry): void {
    const all = this.read();
    all.set(sessionId, entry);
    this.write(all);
  }

  remove(sessionId: string): void {
    const all = this.read();
    if (all.delete(sessionId)) this.write(all);
  }

  private read(): Map<string, RegistryEntry> {
    const out = new Map<string, RegistryEntry>();
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
      for (const [id, entry] of Object.entries(raw)) if (isEntry(entry)) out.set(id, entry);
    } catch {
      return new Map();
    }
    return out;
  }

  private write(all: Map<string, RegistryEntry>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(all), null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
