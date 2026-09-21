import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverAndPersistUiProfile, discoverUiProfile, loadUiProfile } from "../../src/uieng/discovery.ts";
import { validateRecord } from "../../src/uieng/schemas.ts";

let dir: string;
let persisted: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "uieng-discovery-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "demo-ui",
      scripts: { dev: "vite", build: "vite build", start: "vite preview" },
      dependencies: { react: "^18", next: "^14", tailwindcss: "^3" },
    }),
  );
  await mkdir(join(dir, "src/app"), { recursive: true });
  await mkdir(join(dir, "src/components"), { recursive: true });
  await mkdir(join(dir, "src/design-system"), { recursive: true });
  await mkdir(join(dir, "docs/design"), { recursive: true });
  await writeFile(join(dir, "src/app/page.tsx"), "export default () => null;\n");
  await writeFile(join(dir, "src/components/Button.tsx"), "export const Button = () => null;\n");
  await writeFile(
    join(dir, "src/design-system/tokens.json"),
    JSON.stringify({ breakpoints: { sm: "640px", md: "768px" }, color: { primary: "#000" } }),
  );
  await writeFile(join(dir, "playwright.config.ts"), "export default {};\n");
  await writeFile(join(dir, "docs/design/ui-spec.md"), "# UI spec\n");
  persisted = join(dir, "ui-profile.json");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("discoverUiProfile", () => {
  it("detects UI presence, framework, routes, components, tokens and responsive targets", async () => {
    const profile = await discoverUiProfile(dir);
    assert.equal(profile.ui_present, true);
    assert.equal(profile.framework, "next");
    assert.ok(profile.frameworks_detected.includes("react"));
    assert.ok(profile.routes.some((r) => r.endsWith("page.tsx")));
    assert.ok(profile.components.some((c) => c.endsWith("Button.tsx")));
    assert.ok(profile.component_count >= 1);
    assert.equal(profile.styling, "tailwind");
    assert.ok(profile.token_files.some((t) => t.endsWith("tokens.json")));
    assert.ok(profile.tokens?.color);
    assert.ok(profile.responsive_targets.includes("sm:640px"));
    assert.equal(profile.startup.dev, "vite");
    assert.equal(profile.startup.build, "vite build");
    assert.ok(profile.browser_tests.some((t) => t.endsWith("playwright.config.ts")));
    assert.ok(profile.design_docs.some((d) => d.endsWith("ui-spec.md")));
  });

  it("validates against the shared UiProfile schema", async () => {
    const profile = await discoverUiProfile(dir);
    assert.equal(validateRecord("ui_profile", profile), true);
  });
});

describe("persist/load + automatic entry point", () => {
  it("discoverAndPersistUiProfile persists a loadable profile", async () => {
    const profile = await discoverAndPersistUiProfile(dir, persisted);
    assert.ok(profile.id.length > 0);
    const loaded = await loadUiProfile(persisted);
    assert.ok(loaded, "persisted profile should load");
    assert.equal(loaded?.ui_present, true);
    assert.equal(loaded?.framework, profile.framework);
  });

  it("loadUiProfile returns undefined for a missing file", async () => {
    assert.equal(await loadUiProfile(join(dir, "does-not-exist.json")), undefined);
  });
});
