import { redactSecrets } from "../../security/SecurityPolicy.ts";
import type { ControlPlaneIngest } from "./ControlPlaneIngest.ts";

export interface MissionAttentionSnapshot {
  missionId: string;
  title: string;
  state: string;
  health: string;
  operatorPausedAt?: string | null;
}

type AttentionStage = "complete" | "failed" | "stalled";
interface PendingDelivery {
  title: string;
  stage: AttentionStage;
  resolve: (delivered: boolean) => void;
}
interface MissionDelivery {
  pending?: PendingDelivery;
}

/** The mission controller's terminal state takes precedence over derived health. */
function attentionStage(snapshot: MissionAttentionSnapshot): AttentionStage | undefined {
  const state = snapshot.state.toLowerCase();
  const health = snapshot.health.toLowerCase();
  if (["canceled", "cancelled", "paused"].includes(state) || snapshot.operatorPausedAt) return undefined;
  if (["complete", "completed"].includes(state)) return "complete";
  if (["failed", "crashed"].includes(state)) return "failed";
  if (health === "complete") return "complete";
  if (health === "failed") return "failed";
  if (health === "stalled") return "stalled";
  return undefined;
}

/**
 * Send only mission attention transitions to HerdR's existing ingest contract.
 * Local activity and opt-in inspector telemetry are independent of this reporter.
 * Seed restored snapshots before subscribing so reconnects never replay alerts.
 * Delivery is best effort and serialized per mission; ordinary UI refreshes
 * cannot become a network retry loop. At most one pending transition is kept,
 * coalesced to the newest state while a request is in flight. A recovery drops
 * unsent alerts and rearms a subsequent stall.
 */
export class MissionAttentionReporter {
  private readonly stages = new Map<string, AttentionStage | undefined>();
  private readonly deliveries = new Map<string, MissionDelivery>();
  private readonly ingest: Pick<ControlPlaneIngest, "emit">;

  constructor(ingest: Pick<ControlPlaneIngest, "emit">) {
    this.ingest = ingest;
  }

  seed(snapshot: MissionAttentionSnapshot): void {
    this.stages.set(snapshot.missionId, attentionStage(snapshot));
  }

  async update(snapshot: MissionAttentionSnapshot): Promise<boolean> {
    const stage = attentionStage(snapshot);
    const previous = this.stages.get(snapshot.missionId);
    // Reserve synchronously before any I/O, including simultaneous callbacks.
    this.stages.set(snapshot.missionId, stage);
    const delivery = this.deliveries.get(snapshot.missionId);
    if (!stage) {
      delivery?.pending?.resolve(false);
      if (delivery) delivery.pending = undefined;
      return false;
    }
    if (stage === previous) return false;
    return new Promise<boolean>((resolve) => {
      const queue = delivery ?? {};
      // One in-flight request + one newest pending transition per mission.
      queue.pending?.resolve(false);
      queue.pending = {
        title: redactSecrets(snapshot.title)
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 160),
        stage,
        resolve,
      };
      if (!delivery) {
        this.deliveries.set(snapshot.missionId, queue);
        void this.drain(snapshot.missionId, queue);
      }
    });
  }

  private async drain(missionId: string, queue: MissionDelivery): Promise<void> {
    while (queue.pending) {
      const next = queue.pending;
      queue.pending = undefined;
      try {
        const delivered = await this.ingest.emit("mission", missionId, "mission.updated", {
          title: next.title,
          stage: next.stage,
        });
        next.resolve(delivered);
      } catch {
        next.resolve(false);
      }
    }
    this.deliveries.delete(missionId);
  }
}
