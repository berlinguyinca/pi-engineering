/**
 * Child process for the registry crash-recovery test (issue #258). Registers a
 * worktree resource, begins its release (the crash window), writes a marker
 * file and hangs so the parent can SIGKILL it exactly inside the window.
 */
import { writeFile } from "node:fs/promises";
import { ResourceRegistry } from "../../src/resources/ResourceRegistry.ts";

interface Config {
  stateDir: string;
  hostId: string;
  id: string;
  locator: string;
  missionId: string;
  executionId: string;
  marker: string;
}

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const registry = new ResourceRegistry(config.stateDir, config.hostId);
await registry.register({
  id: config.id,
  kind: "worktree",
  ownerMissionId: config.missionId,
  ownerExecutionId: config.executionId,
  locator: config.locator,
  lease: "session:crash-child",
});
const begun = await registry.beginRelease(
  config.id,
  { missionId: config.missionId, executionId: config.executionId },
  () => false,
);
if (begun.status !== "ok") throw new Error(`beginRelease returned ${begun.status}`);
await writeFile(config.marker, "RELEASING\n");
setInterval(() => {}, 1000);
