import type { DurableMemoryRecord } from "./OpenViking.ts";
/**
 * Dashboard panels — deterministic, machine-readable data a control plane /
 * dashboard (B-105) can render. Pure + dependency-free.
 */
import type { BlackholeTelemetry } from "./telemetry.ts";
import type { MemoryEntry } from "./types.ts";

export interface DashboardPanel {
  id: string;
  title: string;
  rows: Array<Record<string, string | number | boolean>>;
}

/** Panel 1: Blackhole runtime health (from telemetry snapshot). */
export function panelHealth(t: BlackholeTelemetry): DashboardPanel {
  return {
    id: "blackhole.health",
    title: "Blackhole runtime",
    rows: [
      { metric: "enabled", value: t.enabled },
      { metric: "provider", value: t.provider },
      { metric: "version", value: t.version },
      { metric: "sessions", value: t.sessions },
      { metric: "active_sessions", value: t.activeSessions },
      { metric: "entries", value: t.entries },
      { metric: "compactions", value: t.compactions },
    ],
  };
}

/** Panel 2: promotion funnel. */
export function panelPromotion(t: BlackholeTelemetry): DashboardPanel {
  return {
    id: "blackhole.promotion",
    title: "Memory promotion funnel",
    rows: [
      { metric: "candidates", value: t.promotionCandidates },
      { metric: "promoted", value: t.promoted },
      { metric: "observer_runs", value: t.memoryWorkers.observer },
      { metric: "reflector_runs", value: t.memoryWorkers.reflector },
      { metric: "dropper_runs", value: t.memoryWorkers.dropper },
    ],
  };
}

/** Panel 3: promoted durable memory. */
export function panelDurable(records: DurableMemoryRecord[]): DashboardPanel {
  return {
    id: "blackhole.durable",
    title: "Promoted durable memory",
    rows: records.slice(0, 50).map((r) => ({
      id: r.id,
      promotedBy: r.promotedBy,
      evidence: r.evidenceIds.length,
      text: r.text.slice(0, 120),
    })),
  };
}

/** Panel 4: recent session memory entries (recall surface). */
export function panelEntries(entries: MemoryEntry[], limit = 100): DashboardPanel {
  return {
    id: "blackhole.entries",
    title: "Recent session memory",
    rows: entries.slice(0, limit).map((e) => ({
      id: e.id,
      priority: e.priority,
      kind: e.kind,
      createdAt: e.createdAt,
      text: e.text.slice(0, 120),
    })),
  };
}

export function renderPanels(panels: DashboardPanel[]): string {
  return panels
    .map((p) => {
      const header = `## ${p.title}\n\n| ${Object.keys(p.rows[0] ?? { metric: "key" }).join(" | ")} |\n| ${Object.keys(
        p.rows[0] ?? { metric: "key" },
      )
        .map(() => "---")
        .join(" | ")} |`;
      const body = p.rows.map((r) => `| ${Object.values(r).join(" | ")} |`).join("\n");
      return `${header}\n${body}\n`;
    })
    .join("\n");
}
