/**
 * Preloaded into every test process (`node --test --import`): machine-local
 * runtime state (session registry, per-session event streams) goes to a fresh
 * temporary directory, never to the developer's real
 * `~/.local/state/pi-engineering`, and the self-update install root
 * (generations, versions, journal, telemetry) never to the real
 * `~/.pi/pi-engineering`. Tests that need their own roots set
 * PI_ENGINEERING_STATE_DIR / PI_ENGINEERING_HOME themselves.
 */
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stateHooks as safeGitStateHooks, testHooks as safeGitTestHooks } from "../../src/git/safeGit.ts";

// Canonicalize the temp root once, for every test in the process. On macOS
// `$TMPDIR` lives behind `/var` → `/private/var`, while Pi resolves repositories,
// worktrees and its own git state with `realpathSync`. A test that hands out the
// unresolved form hands out a second name for the same directory: scope checks
// refuse it ("Explicit workspace path crosses a symlink boundary"), and git
// resolves the two representations against each other into a doubled prefix
// (`/private/private/var/…`) that fails every `mkdir` under a repository's
// common dir. `os.tmpdir()` re-reads `TMPDIR` on every call, so this reaches
// every `mkdtemp(join(tmpdir(), …))` in the suite — 700+ call sites, one line.
const canonicalTmp = realpathSync(tmpdir());
if (process.env.TMPDIR) process.env.TMPDIR = canonicalTmp;
if (process.env.TMP) process.env.TMP = canonicalTmp;
if (process.env.TEMP) process.env.TEMP = canonicalTmp;

// Memory setup can write a revision marker, and model commands write models.json.
// Neither profile convention may fall through to the developer's real ~/.pi/agent.
const profileDir =
  process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || mkdtempSync(join(tmpdir(), "pi-eng-test-profile-"));
if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = profileDir;
if (!process.env.PI_AGENT_DIR) process.env.PI_AGENT_DIR = profileDir;

// Resolve the agent directory the way the product does (loadHindsightSettings reads PI_CODING_AGENT_DIR) and refuse
// to run when it, or the models profile, is outside the temp directory: durable memory is on by default, so a real
// ~/.pi/agent/engineering.yaml would make the suite call a real herdr-memory CLI. This also covers a developer who
// has only PI_AGENT_DIR pointing at a real directory (it is copied into PI_CODING_AGENT_DIR above).
for (const [name, dir] of [
  ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR],
  ["PI_AGENT_DIR", process.env.PI_AGENT_DIR],
] as const) {
  const rel = relative(resolve(tmpdir()), resolve(dir ?? ""));
  if (!dir || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `test isolation: ${name}=${dir} is outside ${tmpdir()}. Tests must not read a real Pi profile (durable memory is on by default); unset it or point it at a temporary directory.`,
    );
  }
}

// Durable memory (memory.hindsight) is ON by default, so a test process must not shell out to a real herdr-memory
// CLI. The hermetic profile states `enabled: false` in its own global YAML (no environment variable). Tests of the
// default or of a live provider pass their own agent directory or write their own engineering.yaml.
{
  const yamlPath = join(profileDir, "engineering.yaml");
  // Only a temporary directory without a YAML of its own is written to (checked above).
  if (existsSync(profileDir) && !existsSync(yamlPath))
    writeFileSync(yamlPath, "memory:\n  hindsight:\n    enabled: false\n");
}

if (!process.env.PI_ENGINEERING_STATE_DIR) {
  process.env.PI_ENGINEERING_STATE_DIR = mkdtempSync(join(tmpdir(), "pi-eng-test-state-"));
}
// Fleet connectivity is OFF for tests by default: a machine's live herdr
// connection config (engineering.yaml `herdr:` block, HERDR_INGEST_URL) must
// not activate inside a test process — no telemetry to a live control plane,
// and no background fetches polluting global-fetch stubs. Connection-layer
// tests opt back in explicitly by clearing HERDR_DISABLED.
if (!process.env.HERDR_DISABLED) {
  process.env.HERDR_DISABLED = "1";
}
if (!process.env.PI_ENGINEERING_HOME) {
  process.env.PI_ENGINEERING_HOME = mkdtempSync(join(tmpdir(), "pi-eng-test-install-"));
}

// The retired Herdr environment variables are never an input to a test (Herdr is configured by YAML only).
for (const name of ["HERDR_INGEST_URL", "HERDR_INGEST_API_KEY", "HERDR_HOST_ID"]) delete process.env[name];

// Test repositories use local bare repositories as remotes. safeGit refuses local-path / file:// remotes unless the
// operator listed them in `pi.allowedRemote`, so the suite enables local transports as a whole; the tests that check
// that refusal switch it off (`testHooks.localTransports = false`) for their own duration.
safeGitTestHooks.localTransports = true;

// Listing the shared temp directory for legacy leftovers can take seconds on a busy machine; tests do not do it
// (the sweeper test points `legacyDir` at a directory of its own).
safeGitStateHooks.legacyDir = null;
