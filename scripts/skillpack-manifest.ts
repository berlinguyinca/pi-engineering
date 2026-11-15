// Regenerate a skill pack's digest manifest after an intentional content change.
// usage: node scripts/skillpack-manifest.ts [packDir]   (default skill-packs/pe-operator)
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PACK_MANIFEST_FILE, buildPackManifest } from "../src/skillpack/verify.ts";

const dir = resolve(process.argv[2] ?? "skill-packs/pe-operator");
writeFileSync(join(dir, PACK_MANIFEST_FILE), `${JSON.stringify(buildPackManifest(dir), null, 2)}\n`);
process.stdout.write(`wrote ${join(dir, PACK_MANIFEST_FILE)}\n`);
