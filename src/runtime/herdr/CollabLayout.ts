/**
 * CollabLayout — the naming and linking contract shared with herdr-engineering's
 * collaboration network (HCN), so pi-engineering workers show up in the same
 * herdr layout and the same flow graph as collaboration agents.
 *
 *  - A fleet lives in herdr workspace `herd-<prefix>`: one tab per agent (named after
 *    it); helpers an agent starts are panes split from its tab, named after themselves.
 *  - An agent's pane is linked as `pane:<host>:<pane>` (`herdr:` is the fabric
 *    session namespace and is not the same thing).
 *  - Names are 1-32 lowercase letters, digits and hyphens, tidied the same way the
 *    control plane tidies them, so a rename on either side converges.
 *
 * Pure functions only; nothing here talks to herdr or the network.
 */

const NAME_MAX = 32;
const PANE_LINK = /^pane:([A-Za-z0-9._-]{1,64}):([A-Za-z0-9._:-]{1,64})$/;

/** Tidy a free-form label into a valid agent name ("Fresh Name!" -> "fresh-name"); null when nothing is left. */
export function tidyAgentName(label: string): string | null {
  const name = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX)
    .replace(/-+$/g, "");
  return name || null;
}

/** The workspace a fleet with this name prefix lives in. */
export function herdWorkspaceLabel(prefix: string): string {
  return `herd-${tidyAgentName(prefix) ?? "fleet"}`;
}

/** `pane:<host>:<pane>`, or null when either part is not a plain token. */
export function paneLink(hostId: string, paneId: string): string | null {
  const link = `pane:${hostId}:${paneId}`;
  return PANE_LINK.test(link) ? link : null;
}

export function parsePaneLink(link: string): { hostId: string; paneId: string } | null {
  const m = PANE_LINK.exec(link);
  return m ? { hostId: m[1] as string, paneId: m[2] as string } : null;
}
