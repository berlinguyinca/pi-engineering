import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REAL_PE_OPERATOR = join(import.meta.dirname, "..", "..", "skill-packs", "pe-operator");

/** A repository whose `.pi/engineering.yaml` grants the real pe-operator pack to the given roles only. */
export function repoGrantingPack(roles: readonly string[], pack = "pe-operator"): { repo: string; state: string } {
  const base = mkdtempSync(join(tmpdir(), "pe-wsp-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".pi"), { recursive: true });
  cpSync(REAL_PE_OPERATOR, join(repo, "skill-packs", pack), { recursive: true });
  const lines = roles.map((r) => `    ${r}: [${pack}]`).join("\n");
  writeFileSync(join(repo, ".pi", "engineering.yaml"), `workers:\n  skillPacks:\n${lines}\n`);
  return { repo, state: join(base, "state") };
}
