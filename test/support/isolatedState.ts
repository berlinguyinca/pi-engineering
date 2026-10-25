/**
 * Preloaded into every test process (`node --test --import`): machine-local
 * runtime state (session registry, per-session event streams) goes to a fresh
 * temporary directory, never to the developer's real
 * `~/.local/state/pi-engineering`, and the self-update install root
 * (generations, versions, journal, telemetry) never to the real
 * `~/.pi/pi-engineering`. Tests that need their own roots set
 * PI_ENGINEERING_STATE_DIR / PI_ENGINEERING_HOME themselves.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateHooks as safeGitStateHooks, testHooks as safeGitTestHooks } from "../../src/git/safeGit.ts";

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
