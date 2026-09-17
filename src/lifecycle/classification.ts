/**
 * Work + risk classification (spec §8).
 *
 * Signals come from four places — the user's words, the changed paths, the diff
 * content, and the commands that were executed. The classifier is pure and
 * deterministic so a classification can be replayed and audited.
 */

import type { Classification, LifecycleRisk, PlanTrigger, WorkCategory } from "./types.ts";
import { LIFECYCLE_RISKS } from "./types.ts";

interface Rule {
  category: WorkCategory;
  /** Path patterns (posix, repo-relative). */
  paths?: RegExp[];
  /** Diff/content patterns. */
  content?: RegExp[];
  /** Words in the request. */
  intent?: RegExp[];
  /** Command patterns that imply this category. */
  commands?: RegExp[];
}

const RULES: Rule[] = [
  {
    category: "docs",
    paths: [/^(docs?|\.github\/ISSUE_TEMPLATE|README|CHANGELOG|CONTRIBUTING)/i, /\.(md|mdx|rst|adoc)$/i],
    intent: [/\b(document|readme|changelog|docs?)\b/i],
  },
  {
    category: "test",
    paths: [/^tests?\//i, /^src\/.*\.(test|spec)\./i, /\.(test|spec)\.(ts|tsx|js|jsx|py|go|rs)$/i, /__tests__\//],
    intent: [/\b(test|spec|coverage|assert)\b/i],
    commands: [/\b(node --test|vitest|jest|pytest|go test|cargo test|npm (run )?test)\b/],
  },
  {
    category: "database",
    paths: [/\.(sql)$/i, /(^|\/)(migrations?|schema|db)\//i, /prisma\/schema\.prisma$/i, /drizzle\//i],
    content: [/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|CONSTRAINT)\b/i, /\bSELECT .* FROM\b/i, /\bINSERT INTO\b/i],
    intent: [/\b(database|schema|migration|sql|query)\b/i],
  },
  {
    category: "migration",
    paths: [/(^|\/)(migrations?|upgrades?)\//i, /\.migration\./i],
    intent: [/\bmigrat/i],
  },
  {
    category: "api",
    paths: [/(^|\/)(api|routes|endpoints|controllers|openapi|graphql)\//i, /openapi\.(ya?ml|json)$/i, /\.graphql$/i],
    content: [/\b(router\.(get|post|put|delete)|app\.(get|post|put|delete)|@Controller|Resolver)\b/],
    intent: [/\b(api|endpoint|rest|grpc|graphql)\b/i],
  },
  {
    category: "security",
    paths: [/(^|\/)(security|auth|crypto|acl|policy)\//i, /(^|\/)(Dockerfile|\.dockerignore)$/i],
    content: [
      /\b(secret|token|credential|password|api[_-]?key|private[_-]?key)\b/i,
      /\b(helmet|cors|jwt|bcrypt|ssh-keygen)\b/,
    ],
    intent: [/\b(security|vulnerab|secret|credential|auth)\b/i],
  },
  {
    category: "auth",
    paths: [/(^|\/)(auth|login|session|oauth|sso)\//i],
    content: [/\b(login|oauth|session|passport|oidc)\b/i],
    intent: [/\b(login|oauth|sso|authentication|authorization)\b/i],
  },
  {
    category: "infra",
    paths: [/(^|\/)(terraform|pulumi|ansible|k8s|kubernetes|helm|infra|deployments?)\//i, /\.(tf|tpl|hcl)$/i],
    intent: [/\b(terraform|ansible|kubernetes|helm|infrastructure|iac)\b/i],
    commands: [/\b(terraform|ansible-playbook|ansible|kubectl|helm|cloudflared)\b/],
  },
  {
    category: "deployment",
    paths: [/(^|\/)(\.github\/workflows|\.gitlab-ci|Jenkinsfile|Dockerfile|docker-compose)/i],
    intent: [/\b(deploy|release|rollout|ci\/cd)\b/i],
    commands: [/\b(deploy|rollout|helm upgrade)\b/],
  },
  {
    category: "service_management",
    paths: [/(^|\/)systemd\//i, /\.service$/i],
    intent: [/\b(systemd|service|daemon|restart (the )?service)\b/i],
    commands: [/\b(systemctl|service|launchctl|journalctl)\b/],
  },
  {
    category: "remote_administration",
    intent: [/\b(ssh|remote (server|host)|bastion|provision)\b/i],
    commands: [/^\s*(ssh|scp|sftp|rsync)\b/],
  },
  {
    category: "server_lifecycle",
    intent: [/\b(start|stop|restart|shutdown) (the )?(server|node|worker)\b/i],
    commands: [/\b(shutdown|reboot|pm2|nodemon|systemctl (start|stop|restart))\b/],
  },
  {
    category: "config",
    paths: [/\.ya?ml$/i, /\.toml$/i, /\.ini$/i, /\.env(\.|$)/i, /(^|\/)config\//i, /\.json5?$/i],
    intent: [/\b(config|configuration|settings|flag)\b/i],
  },
  {
    category: "dependency",
    paths: [
      /(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|requirements\.txt|pyproject\.toml|Gemfile|pom\.xml|build\.gradle)/i,
    ],
    content: [/^\+.*"(dependencies|devDependencies)"/m],
    intent: [/\b(dependenc|upgrade|bump version|update (npm|pip|cargo|go))\b/i],
  },
  {
    category: "build_system",
    paths: [
      /(Makefile|CMakeLists\.txt|vite\.config|webpack\.config|rollup\.config|tsconfig.*\.json|esbuild|turbo\.json|babel\.config|jest\.config|biome\.json)/i,
    ],
    intent: [/\b(build|bundle|compile|toolchain|tsconfig)\b/i],
  },
  {
    category: "runtime_system",
    paths: [/(^|\/)(src\/(runtime|kernel|daemon|worker|cli)|server\.(ts|js)|main\.(ts|go|rs|py))(.test)?\./i],
    intent: [/\b(runtime|daemon|event loop|thread|process|concurrency)\b/i],
  },
  {
    category: "frontend",
    paths: [/(^|\/)(src\/(web|front-end|frontend|app|components|pages|ui)|.*\.(tsx|jsx|vue|svelte|css|scss))(\/|$)/i],
    intent: [/\b(frontend|react|component|page|screen|css|styling)\b/i],
  },
  {
    category: "backend",
    paths: [/(^|\/)(src\/(server|services|domain|db|queue)|.*\.go$|.*\.rs$)/i],
    intent: [/\b(backend|server-side|worker|queue)\b/i],
  },
  {
    category: "visual",
    paths: [/\.(png|jpg|jpeg|gif|webp|svg|ico|avif)$/i],
    intent: [/\b(screenshot|mockup|design|visual|image|icon|logo)\b/i],
  },
  {
    category: "ui_ux",
    paths: [/(^|\/)(components?|pages?|layouts?|styles?|theme|design-system)\//i, /\.(css|scss|less)$/i],
    content: [/\b(className|<div|<button|aria-|role=|:hover|:focus)\b/],
    intent: [/\b(ui|ux|layout|button|form|modal|navigation|usability)\b/i],
  },
  {
    category: "accessibility",
    content: [/\baria-|\balt=|\brole=|tabindex/i],
    intent: [/\b(accessib|a11y|screen reader|wcag)\b/i],
  },
  {
    category: "performance",
    content: [/\b(memo\(|useMemo|cache|debounce|index\s+\w+|O\(n\^2)|lazy/i],
    intent: [/\b(performance|slow|latency|memory leak|optimize|n\+1)\b/i],
    commands: [/\b(autocannon|k6|hyperfine|bench)\b/],
  },
  {
    category: "observability",
    paths: [/(^|\/)(otel|monitoring|logging|dashboards?)\//i],
    content: [/\b(createTrace|span|logger\.|prometheus|opentelemetry|metrics)\b/],
    intent: [/\b(logging|metrics|tracing|observab|alerting)\b/i],
  },
  {
    category: "destructive",
    content: [/^\-\-\- a\//m],
    intent: [/\b(delete|drop|remove|purge|wipe|truncate|destroy)\b/i],
  },
];

const CHAT_ONLY = /^\s*(hi|hello|hey|thanks|thank you|what|why|how|explain|describe|show me|tell me|who|when|where)\b/i;

/** Categories that never need a plan even when the risk ladder would ask for one. */
const PLAN_EXEMPT: readonly WorkCategory[] = ["docs", "chat", "test"];

export function riskRank(risk: LifecycleRisk): number {
  return LIFECYCLE_RISKS.indexOf(risk);
}

export function maxRisk(a: LifecycleRisk, b: LifecycleRisk): LifecycleRisk {
  return riskRank(a) >= riskRank(b) ? a : b;
}

export interface ClassificationInput {
  request?: string;
  files: { path: string; added: boolean; deleted: boolean }[];
  diffExcerpt?: string;
  commands?: string[];
  /** Risk floor coming from the destructive-command gate. */
  riskFloor?: LifecycleRisk;
  /** Diff size signal used for the `large_change` plan trigger. */
  changedLines?: number;
}

/** Classify work categories, risk, plan triggers and specialist roles. */
export function classifyWork(input: ClassificationInput): Classification {
  const reasons: string[] = [];
  const categories = new Set<WorkCategory>();
  const request = input.request ?? "";
  const diff = input.diffExcerpt ?? "";
  const commands = input.commands ?? [];

  for (const rule of RULES) {
    const hits: string[] = [];
    if (input.request && rule.intent?.some((re) => re.test(request))) hits.push("intent");
    if (rule.paths?.length) {
      const matched = input.files.find((f) => rule.paths!.some((re) => re.test(f.path)));
      if (matched) hits.push(`path:${matched.path}`);
    }
    if (diff && rule.content?.some((re) => re.test(diff))) hits.push("diff");
    if (commands.length && rule.commands?.some((re) => commands.some((c) => re.test(c)))) hits.push("command");
    if (hits.length) {
      categories.add(rule.category);
      reasons.push(`${rule.category} from ${hits.slice(0, 2).join(", ")}`);
    }
  }

  // A "destructive" intent only counts when something was actually deleted.
  if (categories.has("destructive") && !input.files.some((f) => f.deleted)) categories.delete("destructive");

  if (categories.size === 0) {
    if (!input.files.length && request && (CHAT_ONLY.test(request) || !commands.length)) {
      categories.add("chat");
      reasons.push("no files changed and no mutating commands observed");
    } else {
      categories.add("unknown");
      reasons.push("no rule matched; defaulting to unknown for conservative routing");
    }
  }

  let risk: LifecycleRisk = "LOW";
  const highCategories: WorkCategory[] = [
    "database",
    "security",
    "auth",
    "infra",
    "migration",
    "deployment",
    "service_management",
    "remote_administration",
    "server_lifecycle",
    "destructive",
  ];
  const normalCategories: WorkCategory[] = ["api", "config", "dependency", "build_system", "runtime_system", "backend"];
  for (const c of categories) {
    if (highCategories.includes(c)) risk = maxRisk(risk, "HIGH");
    else if (normalCategories.includes(c)) risk = maxRisk(risk, "NORMAL");
  }
  if (
    categories.has("destructive") ||
    commands.some((c) => /\b(rm -rf|DROP TABLE|git push --force|terraform destroy)\b/.test(c))
  ) {
    risk = maxRisk(risk, "CRITICAL");
  }
  if (input.riskFloor) risk = maxRisk(risk, input.riskFloor);
  if (categories.has("chat")) risk = maxRisk("LOW", risk === "CRITICAL" ? "CRITICAL" : "LOW");
  reasons.push(`risk ${risk}`);

  const planTriggers = new Set<PlanTrigger>();
  const modules = new Set(
    input.files.map((f) => f.path.split("/").slice(0, 2).join("/")).filter((p) => p.includes("/") || p.includes(".")),
  );
  if (modules.size >= 4) {
    planTriggers.add("cross_module");
    reasons.push(`plan trigger cross_module (${modules.size} areas touched)`);
  }
  if (input.files.length > 12 || (input.changedLines ?? 0) > 600) {
    planTriggers.add("large_change");
    reasons.push("plan trigger large_change");
  }
  if (categories.has("database") || categories.has("migration")) planTriggers.add("data_model");
  if (categories.has("security") || categories.has("auth")) planTriggers.add("security");
  if (categories.has("infra") || categories.has("deployment")) planTriggers.add("infra");
  if (categories.has("api")) planTriggers.add("public_api");
  if (categories.has("ui_ux") || categories.has("visual")) planTriggers.add("user_visible");
  if (categories.has("dependency")) planTriggers.add("cost");
  if (/\b(or|either|unclear|maybe|not sure|what do you think)\b/i.test(request)) planTriggers.add("ambiguous");

  const specialists = specialistRoles(categories, risk);
  const visionRequired =
    categories.has("visual") ||
    categories.has("ui_ux") ||
    categories.has("accessibility") ||
    categories.has("frontend");

  return {
    categories: [...categories],
    risk,
    planTriggers: [...planTriggers],
    specialists,
    visionRequired,
    reasons,
  };
}

/** Specialist roles required by a classification (spec §15). */
export function specialistRoles(categories: Set<WorkCategory> | WorkCategory[], risk: LifecycleRisk): string[] {
  const cats = new Set(categories);
  const out: string[] = [];
  if (cats.has("security") || cats.has("auth") || risk === "CRITICAL") out.push("security_reviewer");
  if (cats.has("database") || cats.has("migration")) out.push("database_reviewer");
  if (cats.has("api")) out.push("api_reviewer");
  if (
    cats.has("infra") ||
    cats.has("deployment") ||
    cats.has("remote_administration") ||
    cats.has("service_management")
  ) {
    out.push("infrastructure_reviewer");
  }
  if (cats.has("performance")) out.push("performance_reviewer");
  if (cats.has("runtime_system") || cats.has("build_system") || riskRank(risk) >= riskRank("HIGH"))
    out.push("architecture_reviewer");
  if (cats.has("test")) out.push("test_reviewer");
  if (cats.has("docs")) out.push("documentation_reviewer");
  if (cats.has("ui_ux") || cats.has("accessibility")) out.push("ui_reviewer");
  return [...new Set(out)];
}
