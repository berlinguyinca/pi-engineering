/** Process-local control shared by the stable Host and copied runtime generations. */
export interface HostMaintenanceDescription {
  /** Stable Host code captured at bootstrap; a runtime reload cannot change it. */
  hostCommit: string | null;
  /** The active generation's code, never the current checkout HEAD. */
  commit: string | null;
  generation: number | null;
  capabilities: string[];
  pending: boolean;
}

export interface HostMaintenanceReloadRequest {
  expectedCommit: string;
  /** Staged local checkout; only the explicitly selected commit is loaded. */
  sourceRoot?: string;
  /** Safe-point wait budget. Expiry leaves the current generation running. */
  timeoutMs?: number;
}

export interface HostMaintenanceReloadResult {
  ok: boolean;
  commit: string | null;
  generation: number | null;
  error?: string;
}

export interface HostMaintenanceProvider {
  describe(): Promise<HostMaintenanceDescription>;
  reload(request: HostMaintenanceReloadRequest): Promise<HostMaintenanceReloadResult>;
}

const SLOT = Symbol.for("pi-engineering.host-maintenance.v1");
type Globals = Record<symbol, HostMaintenanceProvider | undefined>;

export function getHostMaintenance(): HostMaintenanceProvider | undefined {
  return (globalThis as unknown as Globals)[SLOT];
}

export function publishHostMaintenance(provider: HostMaintenanceProvider): () => void {
  const globals = globalThis as unknown as Globals;
  globals[SLOT] = provider;
  return () => {
    if (globals[SLOT] === provider) delete globals[SLOT];
  };
}
