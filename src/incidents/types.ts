/** Compact incident data shared by Pi and optional incident consumers. */
export type IncidentClassification =
  | "transient_infrastructure"
  | "runtime_tooling"
  | "context_routing"
  | "product_defect"
  | "security_concern"
  | "unknown";

export type IncidentRisk = "low" | "medium" | "high" | "critical";

/** Raw evidence belongs in artifacts; these fields must contain JSON primitives. */
export interface AgentFailureIncident {
  incident_id: string;
  run_id: string;
  repo: string;
  revision: string;
  /** Only this explicit path prefix is removed when computing identity. */
  worktree: string;
  agent_role: string;
  failure_class: string;
  exit_code: number | null;
  /** Nonblank, at most 1024 UTF-16 code units. */
  summary: string;
  /** At most 32 references, each nonblank and at most 2048 UTF-16 code units. */
  artifact_refs: string[];
  reproduction: string;
  command: string;
  /** Stable cause signature supplied by the detecting adapter, not a raw log. */
  root_cause: string;
  classification: IncidentClassification;
  risk: IncidentRisk;
  created_at: string;
}
