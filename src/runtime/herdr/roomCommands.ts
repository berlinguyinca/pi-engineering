/**
 * Registers the `/rooms` and `/room` slash commands. Thin: all behavior lives in roomCli.ts (`runRoomSlash`), shared
 * with `pi-engineering room ...`. Registering a command opens no connection and reads no credential; nothing happens
 * until the user runs one.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type SlashResult, runRoomSlash } from "./roomCli.ts";

export function registerRoomCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const make = (name: "rooms" | "room", description: string) =>
    pi.registerCommand(name, {
      description,
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const r: SlashResult = await runRoomSlash(name, args ?? "", env);
        ctx.ui.notify(r.text, r.level);
      },
    });
  make("rooms", "List the Herdr room this Pi has joined (read-only).");
  make(
    "room",
    "Herdr room: join --code-file <path> | catchup | tasks | artifacts (read-only; HCN offline leaves Pi standalone).",
  );
}
