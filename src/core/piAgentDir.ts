import { homedir } from "node:os";
import { resolve } from "node:path";

/** Resolve Pi's agent profile syntax to one absolute directory. */
export function normalizeAgentDir(path: string): string {
  if (path === "~") return homedir();
  if (/^~[\\/]/.test(path)) return resolve(homedir(), path.slice(2).replaceAll("\\", "/"));
  return resolve(path);
}
