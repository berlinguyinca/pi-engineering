/**
 * Preloaded into every test process (`node --test --import`): machine-local
 * runtime state (session registry, per-session event streams) goes to a fresh
 * temporary directory, never to the developer's real
 * `~/.local/state/pi-engineering`. Tests that need their own state root set
 * PI_ENGINEERING_STATE_DIR themselves.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_ENGINEERING_STATE_DIR) {
  process.env.PI_ENGINEERING_STATE_DIR = mkdtempSync(join(tmpdir(), "pi-eng-test-state-"));
}
