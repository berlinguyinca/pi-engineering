import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ModelTabsComponent, type TabsTheme } from "./modelTabsComponent.ts";
import { type ModelEntry, ProviderTabsState } from "./providerTabs.ts";

type ModelsHost = Pick<ExtensionAPI, "registerCommand" | "setModel">;

/**
 * `/models`: Pi's model picker with one tab per provider.
 *
 * Pi's own `/model` cannot be replaced from an extension, so this is a sibling
 * command. `/models <text>` opens with the filter pre-filled.
 */
export function registerModelTabs(pi: ModelsHost): void {
  pi.registerCommand("models", {
    description: "Switch model, with a tab per provider",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // A custom terminal component needs the full TUI; RPC has dialogs but not this.
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/models needs the interactive terminal UI; use /model.", "warning");
        return;
      }
      const available = ctx.modelRegistry.getAvailable();
      if (available.length === 0) {
        ctx.ui.notify("No models are available. Use /login to add a provider.", "warning");
        return;
      }
      const state = new ProviderTabsState(
        available.map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
        { current: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined },
      );
      if (args.trim()) state.setQuery(args.trim());
      const picked = await ctx.ui.custom<ModelEntry | undefined>(
        (tui, theme, _keys, done) =>
          new ModelTabsComponent(state, theme as unknown as TabsTheme, done, () => tui.requestRender()),
      );
      if (!picked) return;
      const model = available.find((m) => m.provider === picked.provider && m.id === picked.id);
      if (!model) return;
      if (await pi.setModel(model)) ctx.ui.notify(`Model: ${picked.provider}/${picked.id}`, "info");
      else ctx.ui.notify(`No credentials for ${picked.provider}; model not changed.`, "error");
    },
  });
}
