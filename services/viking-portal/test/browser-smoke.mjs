/**
 * Local browser proof only: real portal, HTTP, access-key implementation, and Chromium.
 * Cognito is a test-only local redirect fixture; memory is an owner-indexed in-process map.
 * This does not establish a real Cognito login or upstream OpenViking integration.
 *
 * VIKING_PLAYWRIGHT_MODULE may point to an existing @playwright/test installation.
 * Screenshots default to /tmp/viking-portal-staging; generated key fields are masked.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryKeyStore } from "../src/keys.mjs";
import { startPortal } from "../src/server.mjs";

const require = createRequire(import.meta.url);
const playwrightModule = await import(
  pathToFileURL(require.resolve(process.env.VIKING_PLAYWRIGHT_MODULE || "@playwright/test")).href
);
const { chromium, expect } = playwrightModule.default ?? playwrightModule;
const screenshotDir = process.env.VIKING_SCREENSHOT_DIR || "/tmp/viking-portal-staging";
await mkdir(screenshotDir, { recursive: true });

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const keys = new MemoryKeyStore();
await keys.init();
const records = new Map();
const memory = {
  health: async () => true,
  async store(owner, record) {
    if (!records.has(owner)) records.set(owner, new Map());
    records.get(owner).set(record.id, structuredClone(record));
  },
  async recallAll(owner) {
    return [...(records.get(owner)?.values() ?? [])];
  },
  async search(owner, query) {
    return (await this.recallAll(owner)).filter((record) =>
      `${record.text} ${record.sourceRefs.join(" ")}`.includes(query),
    );
  },
};
let identity = "desktop-user";
const loginAttempts = new Map();
const cognito = {
  authorizationUrl({ state, nonce, verifier }) {
    // No AWS request or JWT bypass in production: this dependency exists only in this script.
    loginAttempts.set(state, { nonce, verifier, sub: identity });
    return `${origin}/auth/callback?${new URLSearchParams({ state, code: state })}`;
  },
  async exchange({ code, nonce, verifier }) {
    const attempt = loginAttempts.get(code);
    assert.ok(attempt, "test authorization code must exist");
    assert.equal(attempt.nonce, nonce);
    assert.equal(attempt.verifier, verifier);
    loginAttempts.delete(code);
    return { sub: attempt.sub, email: `${attempt.sub}@example.test`, expiresAt: Date.now() + 3600000 };
  },
};
const portal = await startPortal({
  port,
  origin,
  issuer: "https://cognito.example.test/browser-fixture",
  cognito,
  keys,
  memory,
});
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true });
  for (const profile of [
    { name: "desktop", viewport: { width: 1440, height: 1000 }, clipboard: true },
    { name: "mobile", viewport: { width: 390, height: 844 }, clipboard: false },
  ]) {
    identity = `${profile.name}-user`;
    const context = await browser.newContext({ viewport: profile.viewport, isMobile: !profile.clipboard });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      if (profile.clipboard) {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      } else {
        // Exercise the supported no-clipboard browser case; no HTTP response is mocked.
        await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
      }
      await page.goto(origin);
      await expect(page.getByRole("link", { name: "Sign in with Cognito" })).toBeVisible();
      await page.screenshot({ path: join(screenshotDir, `${profile.name}-signed-out.png`), fullPage: true });
      await page.getByRole("link", { name: "Sign in with Cognito" }).click();
      await expect(page.getByRole("heading", { name: "Your memories" })).toBeVisible();
      await expect(page.locator("#identity")).toHaveText(`${identity}@example.test`);
      await expect(page.locator("#memory-count")).toHaveText("0 memories");

      const device = `${profile.name} Pi device`;
      await page.getByLabel("Device name").fill(device);
      await page.getByLabel("Expires after").selectOption("7");
      await page.getByRole("button", { name: "Create access key" }).click();
      await expect(page.getByRole("heading", { name: "Save your key now" })).toBeVisible();
      const secret = await page.getByLabel("Access key", { exact: true }).inputValue();
      assert.match(secret, /^vkg_[A-Za-z0-9_-]{43}$/);
      await expect(page.locator("#keys")).toContainText(device);
      await expect(page.locator("#keys")).not.toContainText(secret);
      const listed = await context.request.get(`${origin}/api/keys`);
      assert.equal(listed.status(), 200);
      const listBody = await listed.text();
      assert.equal(listBody.includes(secret), false);
      for (const row of JSON.parse(listBody)) {
        assert.equal("secret" in row, false);
        assert.equal("secretHash" in row, false);
      }
      await expect(page.locator("#pi-config")).toContainText(`PI_OPENVIKING_BASE_URL='${origin}'`);
      await expect(page.locator("#pi-config")).toContainText('chmod 600 "$HOME/.config/pi/viking.key"');
      await page.getByRole("button", { name: "Copy key", exact: true }).click();
      if (profile.clipboard) {
        await expect(page.getByRole("status")).toHaveText("Key copied. Store it securely.");
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), secret);
      } else {
        await expect(page.getByRole("status")).toHaveText("Copy unavailable. Select and copy the key manually.");
        await page.getByLabel("Access key", { exact: true }).selectText();
        assert.equal(await page.getByLabel("Access key", { exact: true }).inputValue(), secret);
      }
      await page.screenshot({
        path: join(screenshotDir, `${profile.name}-key-created.png`),
        fullPage: true,
        mask: [page.getByLabel("Access key", { exact: true })],
      });
      await page.getByRole("button", { name: "I saved it" }).click();
      await expect(page.locator("#new-key")).toBeHidden();
      await expect(page.getByLabel("Access key", { exact: true })).toHaveValue("");

      const attack = '<img src=x onerror="globalThis.vikingXss=true">';
      for (const record of [
        {
          id: "private-evidence",
          text: `Unique ${profile.name} kinase evidence ${attack}`,
          sourceRefs: ["repo:smoke"],
        },
        { id: "other-record", text: "Unrelated calibration note", sourceRefs: ["repo:calibration"] },
      ]) {
        const stored = await fetch(`${origin}/memory`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify(record),
        });
        assert.equal(stored.status, 201);
      }
      await page.reload();
      await expect(page.locator("#memory-count")).toHaveText("2 memories");
      await expect(page.locator("#new-key")).toBeHidden();
      await expect(page.getByLabel("Access key", { exact: true })).toHaveValue("");
      await expect(page.locator("#memories")).toContainText(attack);
      assert.equal(await page.locator("#memories img").count(), 0);
      assert.equal(await page.evaluate(() => globalThis.vikingXss), undefined);
      await page.getByLabel("Search memory text and source references").fill("kinase");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.locator("#memory-count")).toHaveText("1 memory");
      await expect(page.locator("#memories")).toContainText(`Unique ${profile.name} kinase evidence`);
      await expect(page.locator("#memories")).not.toContainText("Unrelated calibration note");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot({ path: join(screenshotDir, `${profile.name}-memories.png`), fullPage: true });
      await page.getByRole("button", { name: `Revoke ${device}`, exact: true }).click();
      await expect(page.getByRole("status")).toHaveText(`Revoked ${device}.`);
      await expect(page.locator("#keys")).toContainText("Revoked");
      assert.equal((await fetch(`${origin}/memory`, { headers: { authorization: `Bearer ${secret}` } })).status, 401);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("link", { name: "Sign in with Cognito" })).toBeVisible();
      assert.equal((await context.request.get(`${origin}/api/me`)).status(), 401);
      assert.deepEqual(errors, []);
      results.push({
        profile: profile.name,
        status: "passed",
        clipboard: profile.clipboard ? "copied" : "manual fallback",
      });
    } catch (error) {
      await page
        .screenshot({
          path: join(screenshotDir, `${profile.name}-failure.png`),
          fullPage: true,
          mask: [page.locator("#key-secret")],
        })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  const report = {
    evidence: "Actual local portal HTTP and Chromium; fixture Cognito and in-process memory only",
    results,
    screenshots: screenshotDir,
  };
  await writeFile(join(screenshotDir, "browser-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await portal.close();
  await keys.close();
}
