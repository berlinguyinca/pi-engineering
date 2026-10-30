/**
 * Per-session / per-mission room scope for control-plane session events.
 *
 * The YAML `herdr.room_id` / `workspace_id` / `instance_id` are only the DEFAULT. One Pi can be attached to several
 * rooms at once, so a session event is tagged from the context it runs in:
 *
 *   explicit (the caller passes it)  >  the session's binding  >  the mission's binding  >  the YAML default
 *
 * Fields merge one by one, so a mission bound to a room still inherits the YAML workspace.
 *
 * `agentInstanceId` names the agent INSTANCE (one Pi process / one worker). It is not the pane-link `instance_id`
 * (`pane:<host>:<pane>`), which names a terminal pane and keeps its meaning.
 *
 * Pure bookkeeping: no I/O, no timers, bounded memory. Values are claims; Herdr validates them against the caller's
 * grants. A malformed id is dropped, never repaired, so a bad binding degrades to the next layer.
 */

export interface SessionScope {
  roomId?: string;
  workspaceId?: string;
  agentInstanceId?: string;
}

export interface ResolveContext {
  sessionId?: string;
  missionId?: string;
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BINDINGS = 1024;
const FIELDS = ["roomId", "workspaceId", "agentInstanceId"] as const;

/** Keep only well-formed ids. */
export function cleanScope(scope: SessionScope | undefined): SessionScope {
  const out: SessionScope = {};
  if (!scope) return out;
  for (const key of FIELDS) {
    const v = scope[key];
    if (typeof v === "string" && ID_RE.test(v)) out[key] = v;
  }
  return out;
}

class BoundedMap {
  private readonly map = new Map<string, SessionScope>();
  set(key: string, scope: SessionScope): void {
    this.map.delete(key);
    this.map.set(key, scope);
    if (this.map.size > MAX_BINDINGS) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  get(key: string | undefined): SessionScope | undefined {
    return key === undefined ? undefined : this.map.get(key);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

export class SessionScopeRegistry {
  private defaults: SessionScope;
  private readonly missions = new BoundedMap();
  private readonly sessions = new BoundedMap();

  constructor(defaults: SessionScope = {}) {
    this.defaults = cleanScope(defaults);
  }

  setDefaults(defaults: SessionScope): void {
    this.defaults = cleanScope(defaults);
  }

  bindMission(missionId: string, scope: SessionScope): void {
    this.missions.set(missionId, cleanScope(scope));
  }

  unbindMission(missionId: string): void {
    this.missions.delete(missionId);
  }

  bindSession(sessionId: string, scope: SessionScope): void {
    this.sessions.set(sessionId, cleanScope(scope));
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** The scope for one event; absent fields stay absent. */
  resolve(ctx: ResolveContext, explicit?: SessionScope): SessionScope {
    const layers = [
      cleanScope(explicit),
      this.sessions.get(ctx.sessionId),
      this.missions.get(ctx.missionId),
      this.defaults,
    ];
    const out: SessionScope = {};
    for (const key of FIELDS) {
      for (const layer of layers) {
        const v = layer?.[key];
        if (v !== undefined) {
          out[key] = v;
          break;
        }
      }
    }
    return out;
  }
}
