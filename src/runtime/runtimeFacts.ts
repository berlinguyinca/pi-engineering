/** The slice of `process` that `runtimeFacts` reads (fakeable in tests). */
export interface ProcessLike {
  versions: { node?: string; bun?: string };
  cpuUsage(): { user: number; system: number };
  memoryUsage(): { rss: number };
}

export interface RuntimeFacts {
  /** Always standard Pi; kept so the control-plane session record and dashboard line keep their shape. */
  runtime_kind: "standard-pi";
  runtime_source: "default";
  js_engine: "bun" | "node";
  js_engine_version: string;
  cpu_s: number;
  rss_mib: number;
}

/**
 * What the running agent is, for the runtime event log / dashboard. Runtime metrics only:
 * inference (tokens, latency, queue) stays in the inference metrics.
 */
export function runtimeFacts(proc: ProcessLike = process): RuntimeFacts {
  const bun = proc.versions.bun;
  const cpu = proc.cpuUsage();
  return {
    runtime_kind: "standard-pi",
    runtime_source: "default",
    js_engine: bun ? "bun" : "node",
    js_engine_version: bun ?? proc.versions.node ?? "unknown",
    cpu_s: Math.round(((cpu.user + cpu.system) / 1e6) * 1000) / 1000,
    rss_mib: Math.round((proc.memoryUsage().rss / 1048576) * 10) / 10,
  };
}
