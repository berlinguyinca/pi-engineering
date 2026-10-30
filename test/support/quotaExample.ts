import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo's commented `quota_fallbacks` example (.pi/engineering.yaml), uncommented and ready to parse. */
export function exampleBlock(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".pi", "engineering.yaml");
  const lines = readFileSync(file, "utf8").split("\n");
  const begin = lines.findIndex((l) => l.startsWith("# BEGIN quota_fallbacks example"));
  const end = lines.findIndex((l) => l.startsWith("# END quota_fallbacks example"));
  if (begin < 0 || end < begin) throw new Error("quota_fallbacks example markers not found in .pi/engineering.yaml");
  return `${lines
    .slice(begin + 1, end)
    .map((l) => l.replace(/^# ?/, ""))
    .join("\n")}\n`;
}
