/**
 * CAV-11 Vision Review Advisory: use a vision-capable model for design-fidelity
 * review WITHOUT overriding hard gates.
 *
 * The vision model reviews a screenshot and returns design findings. These are
 * ADVISORY: they may surface defects for the defect ledger, but they can NEVER
 * waive a deterministic failure, and a deterministic PASS is not demoted by
 * vision prose. This uses the vision-capable model (qwen3.8-27b-vision) as the
 * reviewer — see the standing routing decision.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";

export interface VisionReviewOptions {
  screenshotPath: string;
  cwd: string;
  /** Reviewer model (must be vision-capable). */
  modelId?: string;
  provider?: string;
  /** Human/implementer note about what to check for fidelity. */
  brief?: string;
}

export interface VisionFinding {
  id: string;
  severity: "info" | "low" | "medium" | "high";
  description: string;
}

export interface VisionReviewResult {
  findings: VisionFinding[];
  /** True when the vision model responded (advisory only). */
  completed: boolean;
  raw: string;
  modelId: string;
  /** Vision findings NEVER override hard gates; always false. */
  overrideHardGate: false;
}

/**
 * Dispatch a vision review of a screenshot to the vision-capable model.
 * The result is advisory: it can add findings but cannot waive a deterministic
 * failure. Fails gracefully (returns completed:false) if the model is
 * unavailable, rather than manufacturing findings.
 */
export async function runVisionReview(opts: VisionReviewOptions): Promise<VisionReviewResult> {
  const modelId = opts.modelId ?? "qwen3.8-27b-vision";
  const provider = opts.provider ?? "metabolomics";
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

  let imageData: string;
  try {
    imageData = (await readFile(opts.screenshotPath)).toString("base64");
  } catch {
    return { findings: [], completed: false, raw: "", modelId, overrideHardGate: false };
  }

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const model = runtime.getModel(provider, modelId);
  if (!model) {
    return {
      findings: [],
      completed: false,
      raw: `vision model ${modelId} unavailable`,
      modelId,
      overrideHardGate: false,
    };
  }

  const prompt = `${opts.brief ?? "Review the screenshot for design fidelity (layout, alignment, contrast, spacing, overflow, state visibility)."}\nReturn ONLY a JSON array of findings: [{"id":"F1","severity":"low|medium|high|info","description":"..."}] . Empty array = no issues.`;

  const sessionManager = SessionManager.inMemory(opts.cwd);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => prompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    },
    sessionManager,
    settingsManager,
    tools: [],
    customTools: [],
    thinkingLevel: "off",
  });

  const out = await session.prompt("Review the image and return the JSON findings array only.", {
    images: [{ type: "image" as const, data: imageData, mimeType: "image/png" }],
    expandPromptTemplates: false,
  });
  const rawMessages = (session as unknown as { messages?: unknown[] }).messages ?? [];
  session.dispose();

  const outAny = out as unknown;
  let text = "";
  if (typeof outAny === "string") text = outAny;
  else if (outAny && typeof outAny === "object") {
    const o = outAny as Record<string, unknown>;
    if (typeof o.text === "string") text = o.text;
    else text = JSON.stringify(outAny);
  }
  if (!text.trim()) {
    for (const m of rawMessages) {
      const msg = m as { role?: string; content?: unknown };
      if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) text = msg.content;
      else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const b of msg.content as Array<{ type?: string; text?: string }>) {
          if (b.type === "text" && b.text) text += b.text;
        }
      }
    }
  }

  let findings: VisionFinding[] = [];
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Array<Partial<VisionFinding>>;
      findings = Array.isArray(parsed)
        ? parsed
            .filter((f) => typeof f.description === "string")
            .map((f, i) => ({
              id: f.id ?? `V${i + 1}`,
              severity: (f.severity as VisionFinding["severity"]) ?? "info",
              description: f.description!,
            }))
        : [];
    } catch {
      findings = [];
    }
  }
  return { findings, completed: true, raw: text, modelId, overrideHardGate: false };
}
