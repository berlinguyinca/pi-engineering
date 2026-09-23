/**
 * Resilience observability metrics (resilience spec §25).
 *
 * Counter/Gauge-style in-memory metrics for Grafana. A real exporter can map
 * these onto prom-client; the interface keeps the supervisor independent of the
 * export transport.
 */

export interface ResilienceMetrics {
  /** pi_missions_running */
  missions_running: number;
  /** pi_missions_waiting_for_llm */
  missions_waiting_for_llm: number;
  /** pi_missions_paused_infrastructure */
  missions_paused_infrastructure: number;
  /** pi_llm_request_timeouts_total */
  llm_request_timeouts_total: number;
  /** pi_llm_retries_total */
  llm_retries_total: number;
  /** pi_llm_retry_duration_seconds (cumulative) */
  llm_retry_duration_seconds: number;
  /** pi_gateway_available (1/0 gauge) */
  gateway_available: number;
  /** pi_gateway_outage_duration_seconds (cumulative) */
  gateway_outage_duration_seconds: number;
  /** pi_mission_recoveries_total */
  mission_recoveries_total: number;
  /** pi_mission_recovery_failures_total */
  mission_recovery_failures_total: number;
}

export function initialResilienceMetrics(): ResilienceMetrics {
  return {
    missions_running: 0,
    missions_waiting_for_llm: 0,
    missions_paused_infrastructure: 0,
    llm_request_timeouts_total: 0,
    llm_retries_total: 0,
    llm_retry_duration_seconds: 0,
    gateway_available: 1,
    gateway_outage_duration_seconds: 0,
    mission_recoveries_total: 0,
    mission_recovery_failures_total: 0,
  };
}

/** A simple mutable metrics registry. */
export class ResilienceMetricsRegistry {
  private m: ResilienceMetrics = initialResilienceMetrics();

  get current(): ResilienceMetrics {
    return { ...this.m };
  }

  increment<K extends keyof ResilienceMetrics>(key: K, by = 1): void {
    this.m[key] = (this.m[key] as number) + by;
  }

  setGatewayAvailable(available: boolean): void {
    this.m.gateway_available = available ? 1 : 0;
  }
}
