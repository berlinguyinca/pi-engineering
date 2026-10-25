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
