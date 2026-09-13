/**
 * Roadmap evidence store (spec §8, §26).
 *
 * Durable, append-only JSONL records of generated + manual evidence. Each
 * record binds a milestone + evidence type to a commit, the paths it covers,
 * and a proof (command or artifact reference). Compact metadata lives here;
 * large logs live in the Artifact Store behind artifact:// references.
 */
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RoadmapEvidence } from "./types.ts";

export class RoadmapEvidenceStore {
  private readonly file: string;
  private readonly memoryOnly: boolean;
  private records = new Map<string, RoadmapEvidence>();
  private appendChain: Promise<void> = Promise.resolve();

  private constructor(file: string, memoryOnly: boolean) {
    this.file = file;
    this.memoryOnly = memoryOnly;
  }

  static async open(file: string): Promise<RoadmapEvidenceStore> {
    const store = new RoadmapEvidenceStore(file, false);
    await store.load();
    return store;
  }

  static inMemory(): RoadmapEvidenceStore {
    return new RoadmapEvidenceStore("", true);
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf-8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as RoadmapEvidence;
        if (rec?.id) this.records.set(rec.id, rec);
      } catch {
        // ignore corrupt lines (keep the rest readable)
      }
    }
  }

  /** Serialized, ordered appends (safe under concurrent producers). */
  async put(rec: RoadmapEvidence): Promise<RoadmapEvidence> {
    const op = this.appendChain.then(async () => {
      if (!this.memoryOnly) {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(rec)}\n`, "utf-8");
      }
      this.records.set(rec.id, rec);
    });
    this.appendChain = op.catch(() => {});
    await op;
    return rec;
  }

  list(): RoadmapEvidence[] {
    return [...this.records.values()];
  }

  get(id: string): RoadmapEvidence | undefined {
    return this.records.get(id);
  }

  byMilestone(milestoneId: string): RoadmapEvidence[] {
    return this.list().filter((r) => r.milestone === milestoneId);
  }

  byMilestoneType(milestoneId: string, type: string): RoadmapEvidence[] {
    return this.list().filter((r) => r.milestone === milestoneId && r.type === type);
  }

  clear(): void {
    this.records.clear();
    if (!this.memoryOnly) void rm(this.file, { force: true }).catch(() => {});
  }

  count(): number {
    return this.records.size;
  }
}
