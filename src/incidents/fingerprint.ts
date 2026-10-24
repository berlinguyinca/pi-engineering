import { fnv1a64 } from "../aps/fingerprint.ts";
import type { AgentFailureIncident, IncidentClassification, IncidentRisk } from "./types.ts";

const CLASSIFICATIONS: readonly IncidentClassification[] = [
  "transient_infrastructure",
  "runtime_tooling",
  "context_routing",
  "product_defect",
  "security_concern",
  "unknown",
];
const RISKS: readonly IncidentRisk[] = ["low", "medium", "high", "critical"];

function stripWorktree(value: string, worktree: string): string {
  const prefix = worktree.replace(/\/+$/, "");
  if (!prefix) return value;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match complete path prefixes, including quoted arguments and --cwd= paths.
  // A sibling prefix, an unrelated absolute path, or a URL stays unchanged.
  const pattern = new RegExp(`(^|[\\s"'=(])${escaped}(/|(?=$|[\\s"')]))`, "g");
  return value.replace(pattern, (_match, before: string, slash: string) => `${before}${slash ? "" : "."}`);
}

/**
 * Stable identity excludes occurrence metadata (IDs, timestamps, revision,
 * evidence locations, and triage). Timestamp text in a cause remains meaningful.
 */
export function incidentFingerprint(
  incident: Pick<AgentFailureIncident, "repo" | "failure_class" | "command" | "root_cause" | "worktree">,
): string {
  // Fixed sorted keys provide canonical JSON without collapsing meaningful
  // whitespace in commands/causes as the general APS canonicalizer would.
  return fnv1a64(
    JSON.stringify({
      command: stripWorktree(incident.command, incident.worktree),
      failure_class: incident.failure_class,
      repo: incident.repo.trim().toLowerCase(),
      root_cause: stripWorktree(incident.root_cause, incident.worktree),
    }),
  );
}

function validateBoundedText(value: string, field: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be nonblank text of at most ${maxLength} characters`);
  }
}

/** Validate and project an incident into the versioned, JSON-safe adapter event. */
export function toIncidentEventPayload(incident: AgentFailureIncident) {
  // Explicit projection prevents accidental inclusion of raw logs or host objects.
  const fields = {
    incident_id: incident.incident_id,
    run_id: incident.run_id,
    repo: incident.repo,
    revision: incident.revision,
    worktree: incident.worktree,
    agent_role: incident.agent_role,
    failure_class: incident.failure_class,
    summary: incident.summary,
    reproduction: incident.reproduction,
    command: incident.command,
    root_cause: incident.root_cause,
    classification: incident.classification,
    risk: incident.risk,
    created_at: incident.created_at,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  }
  validateBoundedText(incident.summary, "summary", 1024);
  if (!Array.isArray(incident.artifact_refs) || incident.artifact_refs.length > 32) {
    throw new TypeError("artifact_refs must be an array of at most 32 references");
  }
  for (const ref of incident.artifact_refs) validateBoundedText(ref, "artifact_refs", 2048);
  if (incident.exit_code !== null && !Number.isSafeInteger(incident.exit_code)) {
    throw new TypeError("exit_code must be a safe integer or null");
  }
  if (!CLASSIFICATIONS.includes(incident.classification)) throw new TypeError("Invalid classification");
  if (!RISKS.includes(incident.risk)) throw new TypeError("Invalid risk");

  return {
    type: "agent_failure" as const,
    schema_version: 1 as const,
    ...fields,
    exit_code: incident.exit_code,
    artifact_refs: [...incident.artifact_refs],
    fingerprint: incidentFingerprint(incident),
  };
}
