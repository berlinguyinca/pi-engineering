/**
 * Operator update preferences (spec §12, §14). Persisted user configuration,
 * never transient cluster or download state.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UpdateChannel } from "./gitSource.ts";

export interface UpdatePreferences {
  channel: UpdateChannel;
  /** Check for updates automatically (default: on). */
  autoCheck: boolean;
  /** Install automatically (default: off; spec §14). */
  autoInstall: boolean;
  /** Root commits identifying the trusted repository, recorded on first fetch. */
  identityRoots: string[];
  lastCheckAt?: string;
  lastAvailable?: { version: string; commit: string; channel: UpdateChannel } | null;
}

export const DEFAULT_PREFERENCES: UpdatePreferences = {
  channel: "main",
  autoCheck: true,
  autoInstall: false,
  identityRoots: [],
};

export function readPreferences(file: string): UpdatePreferences {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<UpdatePreferences>;
    return {
      channel: raw.channel === "stable" ? "stable" : "main",
      autoCheck: raw.autoCheck !== false,
      autoInstall: raw.autoInstall === true,
      identityRoots: Array.isArray(raw.identityRoots)
        ? raw.identityRoots.filter((r) => typeof r === "string" && /^[0-9a-f]{40}$/.test(r))
        : [],
      ...(typeof raw.lastCheckAt === "string" ? { lastCheckAt: raw.lastCheckAt } : {}),
      ...(raw.lastAvailable ? { lastAvailable: raw.lastAvailable } : {}),
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function writePreferences(file: string, prefs: UpdatePreferences): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
  await rename(tmp, file);
}
