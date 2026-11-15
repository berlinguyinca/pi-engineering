import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The context firewall as a `--config` overlay. An overlay outranks the user's
 * `~/.omp/agent/config.yml` AND a cloned repo's `.omp/config.yml` (verified
 * against omp 18.20.0), so neither can switch auto-learn back on.
 *
 * Keys (omp registry ids): autolearn.enabled, memory.backend,
 * skills.enabled + skills.enable*{User,Project} (every skill discovery root:
 * ~/.omp, project .omp, ~/.claude, project .claude, ~/.codex, ~/.agents,
 * project .agents), skills.enableSkillCommands, and disabledProviders for the
 * managed-skills provider (`omp-managed`, ~/.omp/agent/managed-skills), which
 * loads at priority 5 even with auto-learn off.
 */
export const OMP_FIREWALL_OVERLAY_YML = `autolearn:
  enabled: false
memory:
  backend: "off"
skills:
  enabled: false
  enableSkillCommands: false
  enableCodexUser: false
  enableClaudeUser: false
  enableClaudeProject: false
  enablePiUser: false
  enablePiProject: false
  enableAgentsUser: false
  enableAgentsProject: false
disabledProviders:
  - omp-managed
`;

/** Flags that accompany the overlay: discovery off on the command line too. */
export const OMP_FIREWALL_FLAGS: readonly string[] = [
  "--no-skills",
  "--no-extensions",
  "--no-rules",
  "--no-context-files",
  "--no-lsp",
  "--no-pty",
  "--no-title",
];

/** Write (idempotently, content-addressed) the overlay and return its path. */
export function ensureFirewallOverlay(dir: string = tmpdir()): string {
  const hash = createHash("sha256").update(OMP_FIREWALL_OVERLAY_YML).digest("hex").slice(0, 12);
  const file = join(dir, `pe-omp-firewall-${hash}.yml`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, OMP_FIREWALL_OVERLAY_YML, { encoding: "utf8", mode: 0o600 });
  }
  return file;
}

/** `--config <overlay>` plus the firewall flags, for every omp process PE launches. */
export function firewallArgs(dir?: string): string[] {
  return ["--config", ensureFirewallOverlay(dir), ...OMP_FIREWALL_FLAGS];
}
