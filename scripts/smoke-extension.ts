/**
 * Smoke test: load the package extension through Pi's ResourceLoader and confirm
 * it registers without errors. This mirrors how `pi install`/`-e` loads the
 * package, without needing an interactive session.
 */
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(here, "..", "extensions", "index.ts");

const loader = new DefaultResourceLoader({
  cwd: process.argv[2] ?? process.cwd(),
  agentDir: getAgentDir(),
  additionalExtensionPaths: [extensionPath],
});
await loader.reload();

const { session, extensionsResult } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  noTools: "all",
});

const errors = extensionsResult?.errors ?? [];
const names = (extensionsResult?.extensions ?? []).map((e: { name?: string }) => e.name);
console.log("Loaded extensions:", names.join(", ") || "(none)");
if (errors.length) {
  console.error("EXTENSION ERRORS:");
  for (const e of errors) console.error(" -", JSON.stringify(e));
  session.dispose();
  process.exit(1);
}
console.log("EXTENSION LOAD OK");
session.dispose();
