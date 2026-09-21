/**
 * Observability / metrics layer for the vision payload pipeline (Phase 7 subset).
 *
 * Pure deterministic in-memory registry that can later be wired to an
 * OpenTelemetry / Grafana exporter. No external dependencies and no network
 * calls. Spec: pi-engineering-vision-payload-management-413-recovery (§45-46).
 */

export type VisionMetricName =
  | "pi_vision_assets_total"
  | "pi_vision_asset_original_bytes"
  | "pi_vision_asset_derivative_bytes"
  | "pi_vision_analysis_requests_total"
  | "pi_vision_cache_hits_total"
  | "pi_request_estimated_bytes"
  | "pi_request_payload_utilization"
  | "pi_http_413_total"
  | "pi_http_413_recovered_total"
  | "pi_context_compactions_total"
  | "pi_context_compaction_byte_pressure_total";

export const VISION_METRIC_NAMES: readonly VisionMetricName[] = [
  "pi_vision_assets_total",
  "pi_vision_asset_original_bytes",
  "pi_vision_asset_derivative_bytes",
  "pi_vision_analysis_requests_total",
  "pi_vision_cache_hits_total",
  "pi_request_estimated_bytes",
  "pi_request_payload_utilization",
  "pi_http_413_total",
  "pi_http_413_recovered_total",
  "pi_context_compactions_total",
  "pi_context_compaction_byte_pressure_total",
];

export interface MetricSample {
  name: VisionMetricName;
  value: number;
  labels?: Record<string, string>;
}

/** Serialize a label map into a stable registry key. */
function labelKey(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return "";
  }
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value !== undefined) {
      sorted[key] = value;
    }
  }
  return JSON.stringify(sorted);
}

/** Render labels in Prometheus exposition format: {k="v",k2="v2"}. */
function renderLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const key of Object.keys(labels).sort()) {
    const escaped = String(labels[key]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    parts.push(`${key}="${escaped}"`);
  }
  return `{${parts.join(",")}}`;
}

export class VisionMetricsRegistry {
  private readonly values = new Map<string, number>();
  private readonly names = new Map<string, VisionMetricName>();
  private readonly labels = new Map<string, Record<string, string>>();

  private keyFor(name: VisionMetricName, labels?: Record<string, string>): string {
    return `${name}\u0000${labelKey(labels)}`;
  }

  /** Increment a counter by 1 (or by `delta` if provided). */
  inc(name: VisionMetricName, labels?: Record<string, string>): void;
  inc(name: VisionMetricName, delta: number, labels?: Record<string, string>): void;
  inc(
    name: VisionMetricName,
    deltaOrLabels?: number | Record<string, string>,
    maybeLabels?: Record<string, string>,
  ): void {
    let delta = 1;
    let labels: Record<string, string> | undefined;
    if (typeof deltaOrLabels === "number") {
      delta = deltaOrLabels;
      labels = maybeLabels;
    } else {
      labels = deltaOrLabels;
    }
    const key = this.keyFor(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
    this.names.set(key, name);
    if (labels) {
      this.labels.set(key, labels);
    }
  }

  /** Record a value (gauge/histogram); stores the latest value. */
  observe(name: VisionMetricName, value: number, labels?: Record<string, string>): void {
    const key = this.keyFor(name, labels);
    this.values.set(key, value);
    this.names.set(key, name);
    if (labels) {
      this.labels.set(key, labels);
    }
  }

  /** Add `value` (default 0) to an existing counter. */
  add(name: VisionMetricName, value: number, labels?: Record<string, string>): void {
    const key = this.keyFor(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
    this.names.set(key, name);
    if (labels) {
      this.labels.set(key, labels);
    }
  }

  /** Return the current value (0 if not set). */
  get(name: VisionMetricName, labels?: Record<string, string>): number {
    return this.values.get(this.keyFor(name, labels)) ?? 0;
  }

  /** Return all recorded samples. */
  snapshot(): MetricSample[] {
    const samples: MetricSample[] = [];
    for (const [key, value] of this.values) {
      const name = this.names.get(key);
      const labels = this.labels.get(key);
      if (name === undefined) {
        continue;
      }
      samples.push({ name, value, ...(labels ? { labels } : {}) });
    }
    return samples;
  }

  /** Clear all recorded samples. */
  reset(): void {
    this.values.clear();
    this.names.clear();
    this.labels.clear();
  }
}

/** Render a Prometheus-style text exposition, sorted for determinism. */
export function exportMetrics(registry: VisionMetricsRegistry): string {
  const lines = registry
    .snapshot()
    .sort((a, b) => {
      if (a.name !== b.name) {
        return a.name < b.name ? -1 : 1;
      }
      const aKey = JSON.stringify(a.labels ?? {});
      const bKey = JSON.stringify(b.labels ?? {});
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    })
    .map((sample) => `${sample.name}${renderLabels(sample.labels)} ${sample.value}`);
  return lines.join("\n");
}

export interface AlertThresholds {
  warn413Rate: number;
  warnPayloadUtilization: number;
  warnRepeatedReanalysis: number;
}

/** Default alert thresholds (spec §46). */
export function alertThresholds(opts?: Partial<AlertThresholds>): AlertThresholds {
  return {
    warn413Rate: opts?.warn413Rate ?? 0.05,
    warnPayloadUtilization: opts?.warnPayloadUtilization ?? 0.8,
    warnRepeatedReanalysis: opts?.warnRepeatedReanalysis ?? 3,
  };
}

/**
 * Deterministic alert check (spec §46).
 * - pi_http_413_total: warn when value > warn413Rate
 * - pi_request_payload_utilization: warn when value > warnPayloadUtilization
 * - pi_vision_analysis_requests_total: warn when value > warnRepeatedReanalysis
 */
export function shouldWarnFor(metric: VisionMetricName, value: number, thresholds?: Partial<AlertThresholds>): boolean {
  const t = alertThresholds(thresholds);
  switch (metric) {
    case "pi_http_413_total":
      return value > t.warn413Rate;
    case "pi_request_payload_utilization":
      return value > t.warnPayloadUtilization;
    case "pi_vision_analysis_requests_total":
      return value > t.warnRepeatedReanalysis;
    default:
      return false;
  }
}
