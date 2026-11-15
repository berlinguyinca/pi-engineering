import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

/** Per-user, private location: the PE state dir, never a shared temp directory. */
export function defaultFirewallDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.PI_ENGINEERING_STATE_DIR?.trim() || join(homedir(), ".local", "state", "pi-engineering");
  return join(state, "omp-firewall");
}

function assertPrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`omp firewall: ${dir} is not a private directory owned by this user`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * Return the path of the overlay, guaranteeing its content is exactly
 * {@link OMP_FIREWALL_OVERLAY_YML} right now: a missing, planted, stale or truncated
 * file is replaced atomically (temp file + rename) before use.
 */
export function ensureFirewallOverlay(dir: string = defaultFirewallDir()): string {
  assertPrivateDir(dir);
  const file = join(dir, "firewall.yml");
  let current: string | undefined;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== OMP_FIREWALL_OVERLAY_YML) {
    const tmp = join(dir, `.firewall.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, OMP_FIREWALL_OVERLAY_YML, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  }
  return file;
}

/** `--config <overlay>` plus the firewall flags, for every omp process PE launches. */
export function firewallArgs(dir?: string): string[] {
  return ["--config", ensureFirewallOverlay(dir), ...OMP_FIREWALL_FLAGS];
}
