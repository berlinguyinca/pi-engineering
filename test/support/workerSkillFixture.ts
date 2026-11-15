import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REAL_PE_OPERATOR = join(import.meta.dirname, "..", "..", "skill-packs", "pe-operator");

export const manifestSha = (packDir: string): string =>
  createHash("sha256")
    .update(readFileSync(join(packDir, "pack.manifest.json")))
    .digest("hex");

const grantYaml = (roles: readonly string[], id: string, sha: string): string =>
  `workers:\n  skillPacks:\n${roles.map((r) => `    ${r}: [{id: ${id}, manifestSha256: "${sha}"}]`).join("\n")}\n`;

/** The operator's side: <agentDir>/skill-packs/<id> plus a pinned allowlist in <agentDir>/engineering.yaml. */
export function installOperatorPack(
  agentDir: string,
  roles: readonly string[],
  opts: { id?: string; sha?: string } = {},
): string {
  const id = opts.id ?? "pe-operator";
  const pack = join(agentDir, "skill-packs", id);
  mkdirSync(join(agentDir, "skill-packs"), { recursive: true });
  cpSync(REAL_PE_OPERATOR, pack, { recursive: true });
  writeFileSync(join(agentDir, "engineering.yaml"), grantYaml(roles, id, opts.sha ?? manifestSha(pack)));
  return pack;
}

/** Re-pin the operator allowlist to the pack as it is now (after a deliberate, manifest-consistent edit). */
export function repinOperator(agentDir: string, roles: readonly string[], id = "pe-operator"): void {
  writeFileSync(
    join(agentDir, "engineering.yaml"),
    grantYaml(roles, id, manifestSha(join(agentDir, "skill-packs", id))),
  );
}

/** A hostile repository: ships its own allowlist and pack, with a correct-looking pin. */
export function plantHostileRepo(repo: string, roles: readonly string[]): void {
  mkdirSync(join(repo, ".pi"), { recursive: true });
  const pack = join(repo, "skill-packs", "pe-operator");
  cpSync(REAL_PE_OPERATOR, pack, { recursive: true });
  writeFileSync(join(repo, ".pi", "engineering.yaml"), grantYaml(roles, "pe-operator", manifestSha(pack)));
}

export interface WorkerSkillFixture {
  repo: string;
  state: string;
  agentDir: string;
  pack: string;
}

/** Operator grants `roles` the real pe-operator pack; the repository is plain. */
export function operatorGrantingPack(roles: readonly string[]): WorkerSkillFixture {
  const base = mkdtempSync(join(tmpdir(), "pe-wsp-"));
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  const agentDir = join(base, "agent");
  const pack = installOperatorPack(agentDir, roles);
  return { repo, state: join(base, "state"), agentDir, pack };
}
