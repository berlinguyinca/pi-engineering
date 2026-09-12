import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-engineering-runtime
 *
 * Placeholder extension entry point.
 *
 * A full spec is pending that will define the actual engineering runtime:
 * the autonomous loop (spec -> plan -> implement -> test -> review), the
 * orchestrator/state model, and the skills it exposes to the pi agent.
 *
 * Until the spec lands, this extension only confirms it loaded successfully
 * and exposes a stub command so the package is wired into pi.
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-eng-runtime", {
    description: "Show pi-engineering-runtime status (stub until spec lands).",
    handler: async (args, ctx) => {
      const status = [
        "pi-engineering-runtime extension loaded.",
        "Spec pending — no engineering workflow implemented yet.",
      ];
      ctx.ui.notify(status.join(" "), "info");
    },
  });
}
