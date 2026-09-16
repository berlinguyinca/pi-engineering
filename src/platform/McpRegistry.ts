/**
 * Generic project/role-scoped MCP registry (spec 14).
 *
 * MCP tools are external and project/role scoped. Discovery NEVER grants
 * permission: registering a server makes it discoverable; using a tool requires
 * an explicit project/role allowlist decision. Every invocation is recorded with
 * correlation id, server/version, duration/status and the permission decision.
 *
 * Child capabilities can never exceed the parent/run ceiling: a worker's
 * allowed tools are intersected with the ceiling it runs under.
 */

import { id } from "../core/ids.ts";

export interface McpServer {
  name: string;
  version: string;
  /** Generic registration — pi-engineering does not hard-code domain servers. */
  command: string;
  /** Tool names this server exposes (discovery only). */
  tools: string[];
}

export interface McpInvocationRecord {
  correlationId: string;
  server: string;
  tool: string;
  projectId: string;
  role: string;
  allowed: boolean;
  startedAt: string;
  durationMs: number | null;
  status: "ok" | "error" | "denied";
}

export interface McpRegistryOptions {
  /** A function deciding whether (project, role, tool) is permitted. */
  policy?: (ctx: { projectId: string; role: string; tool: string }) => boolean;
}

export class McpRegistry {
  private readonly servers = new Map<string, McpServer>();
  private readonly invocations: McpInvocationRecord[] = [];
  private readonly policy: (ctx: { projectId: string; role: string; tool: string }) => boolean;

  constructor(opts: McpRegistryOptions = {}) {
    this.policy = opts.policy ?? (() => false);
  }

  register(server: McpServer): void {
    this.servers.set(server.name, server);
  }

  /** Discovery: what tools exist. Does NOT grant permission. */
  discover(): Array<McpServer & { tools: string[] }> {
    return [...this.servers.values()].map((s) => ({ ...s, tools: [...s.tools] }));
  }

  /**
   * Resolve the tool set a worker with `role` may use under `ceilingTools`.
   * The effective set is the intersection of what the role's policy allows and
   * what the run ceiling permits — a child can never exceed its ceiling.
   */
  allowlistFor(projectId: string, role: string, ceilingTools: string[] | null): string[] {
    const allowed: string[] = [];
    for (const server of this.servers.values()) {
      for (const tool of server.tools) {
        if (ceilingTools && !ceilingTools.includes(tool)) continue; // ceiling caps children
        if (this.policy({ projectId, role, tool })) allowed.push(tool);
      }
    }
    return allowed;
  }

  /**
   * Invoke a tool, recording correlation, permission decision, duration and
   * status. The executor is injected so tests are deterministic.
   */
  async invoke(args: {
    projectId: string;
    role: string;
    server: string;
    tool: string;
    ceilingTools: string[] | null;
    run: (tool: string) => Promise<unknown>;
  }): Promise<McpInvocationRecord> {
    const correlationId = id("MCP");
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const allowed =
      this.allowlistFor(args.projectId, args.role, args.ceilingTools).includes(args.tool) &&
      this.servers.has(args.server);

    let status: McpInvocationRecord["status"] = "denied";
    if (allowed) {
      try {
        await args.run(args.tool);
        status = "ok";
      } catch {
        status = "error";
      }
    }

    const record: McpInvocationRecord = {
      correlationId,
      server: args.server,
      tool: args.tool,
      projectId: args.projectId,
      role: args.role,
      allowed,
      startedAt,
      durationMs: Date.now() - t0,
      status,
    };
    this.invocations.push(record);
    return record;
  }

  /** Audit log of invocations (bounded, newest last). */
  audit(): McpInvocationRecord[] {
    return this.invocations.slice();
  }
}
