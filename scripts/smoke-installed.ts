import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Phase 3 standalone-install test: verify that Pi discovers and loads this
 * package from an *installed* project config (.pi/settings.json) — not from an
 * explicitly-injected extension path. Proves the package behaves as a real Pi
 * package. Run from a fixture repo that has `pi install <pkg> -l`.
 *
 * Usage: node scripts/smoke-installed.ts <fixture-cwd>
 */
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const cwd = process.argv[2] ?? process.cwd();

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  // NOTE: no additionalExtensionPaths — discovery must come from installed config.
});
await loader.reload();

const { session, extensionsResult } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  noTools: "all",
});

const errors = (extensionsResult?.errors ?? []) as Array<{ message?: string; extensionPath?: string }>;
const exts = (extensionsResult?.extensions ?? []) as Array<{ name?: string; path?: string }>;
console.log(`Discovered extensions: ${exts.length}`);
for (const e of exts) console.log("  -", e.name ?? e.path ?? "(unnamed)");
if (errors.length) {
  console.error("LOAD ERRORS:");
  for (const e of errors) console.error("  -", JSON.stringify(e));
  session.dispose();
  process.exit(1);
}
if (exts.length === 0) {
  console.error("No extensions discovered from installed config.");
  session.dispose();
  process.exit(1);
}
console.log("INSTALLED PACKAGE LOADS OK");
session.dispose();
