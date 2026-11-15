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
 *
 * Context trimming (same file, no upstream change): edit.mode=replace swaps omp's hashline edit/read text and
 * schema for the plain old/new form (closest to legacy's tolerant edit); async.enabled and
 * bash.autoBackground.enabled=false drop the backgrounding text and schema from omp's bash tool and make bash
 * run in the foreground as legacy's does. Together about 300 approx tokens off the implementer's first request.
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
edit:
  mode: replace
async:
  enabled: false
bash:
  autoBackground:
    enabled: false
`;

/**
 * Capability providers that could contribute skills from outside an explicitly loaded pack. Only `omp-plugins`
 * (extension-bundled `skills/`, reachable solely through `-e` because `--no-extensions` makes the roots
 * explicit-only) stays enabled in the worker-skills overlay.
 */
const SKILL_PROVIDERS_OFF = [
  "omp-managed",
  "native",
  "skillshare",
  "claude",
  "claude-plugins",
  "agent-plugins",
  "agents",
  "codex",
  "opencode",
  "github",
  "cursor",
  "gemini",
  "windsurf",
];

/**
 * Overlay for a worker granted verified skill packs: identical to {@link OMP_FIREWALL_OVERLAY_YML} except
 * `skills.enabled` is true, every other skill provider is disabled, and no custom skill directories apply.
 * Slash commands for skills, auto-learn and memory stay off.
 */
export const OMP_FIREWALL_SKILLS_OVERLAY_YML = OMP_FIREWALL_OVERLAY_YML.replace(
  "skills:\n  enabled: false\n",
  "skills:\n  enabled: true\n  customDirectories: []\n",
).replace(
  "disabledProviders:\n  - omp-managed\n",
  `disabledProviders:\n${SKILL_PROVIDERS_OFF.map((p) => `  - ${p}`).join("\n")}\n`,
);

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

export function assertPrivateDir(dir: string): void {
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
export function ensureFirewallOverlay(
  dir: string = defaultFirewallDir(),
  content: string = OMP_FIREWALL_OVERLAY_YML,
  name = "firewall.yml",
): string {
  assertPrivateDir(dir);
  const file = join(dir, name);
  let current: string | undefined;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== content) {
    const tmp = join(dir, `.firewall.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  }
  return file;
}

/**
 * `--config <overlay>` plus the firewall flags, for every omp process PE launches. With `skillPackDirs` (verified,
 * staged packs; see src/skillpack/workerPacks.ts) the skills overlay is used, `--no-skills` is dropped and each
 * pack is loaded with `-e`. `--no-extensions` stays, which makes the `-e` roots the only extension roots.
 */
export function firewallArgs(dir?: string, skillPackDirs: readonly string[] = []): string[] {
  if (skillPackDirs.length === 0) return ["--config", ensureFirewallOverlay(dir), ...OMP_FIREWALL_FLAGS];
  return [
    "--config",
    ensureFirewallOverlay(dir, OMP_FIREWALL_SKILLS_OVERLAY_YML, "firewall-skills.yml"),
    ...OMP_FIREWALL_FLAGS.filter((flag) => flag !== "--no-skills"),
    ...skillPackDirs.flatMap((pack) => ["-e", pack]),
  ];
}
