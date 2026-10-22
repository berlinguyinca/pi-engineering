# Sharing the herdr layout with the collaboration network

pi-engineering and herdr-engineering's collaboration network (HCN) place agents in herdr the same way, so a
reader of the dashboard sees one picture of how everything coordinates. The contract lives in
`src/runtime/herdr/CollabLayout.ts`; the other side is documented in herdr-engineering
(`docs/operations/collaboration-network-guide.md`, "5.1c-3").

* **Layout:** workspace `herd-<prefix>`; one tab per agent, named after the agent; helpers an agent starts are
  panes split from the parent's tab, named after themselves.
* **Link:** an agent's pane is `pane:<host>:<pane>` (`herdr:...` is the fabric session namespace, a different thing).
  The worker's session events (`session.started/updated/terminated`) now carry `instance_id` (that link) and,
  when known, `parent_session_id` and `name`. All are additive and optional. The control plane's session ingest currently ignores unknown keys, so these
  are carried on the wire but not yet stored; a consumer must land on that side before they show anywhere.
  `instance_id` is only sent when the target is a pane id, never a workspace id.
* **Names:** 1-32 lowercase letters, digits, hyphens (`tidyAgentName`). The pane label equals the agent name; the
  web name wins ties when both sides rename within one runner cycle.
* **Not done yet:** pi-engineering does not itself call the collaboration `agents/join-link`; that needs a join
  token, which a pi worker does not hold. Agents cannot request spawns; spawning helpers stays operator-driven.
