/**
 * Quick smoke: Stagehand init + observe/act over shared CDP (Playwright server, then AdsPower if configured).
 * Usage: node scripts/stagehand-cdp-smoke.mjs
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { initRuntime } from "../src/runtime.js";
import { canUseStagehand, attemptStagehandFill, closeStagehand } from "../src/layers/stagehandAdapter.js";

const root = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(root, "../../job-apply-ai/.env");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(envPath);

initRuntime({
  settings: {
    stagehand_enabled: true,
    stagehand_cache_enabled: false,
    stagehand_model: process.env.STAGEHAND_MODEL || "",
  },
});

const log = {
  layer: (layer, msg, level = "info") => console.log(`[${level}] [${layer}] ${msg}`),
};

async function smokeWithCdp({ label, cdpUrl, provider, page }) {
  console.log(`\n=== ${label} ===`);
  console.log(`provider=${provider} cdp=${cdpUrl.slice(0, 72)}...`);

  const gate = canUseStagehand({ browserProvider: provider, browserCdpUrl: cdpUrl });
  console.log("canUseStagehand:", gate);
  if (!gate.ok) return { ok: false, phase: "gate", reason: gate.reason };

  const result = await attemptStagehandFill(
    page,
    { browserProvider: provider, browserCdpUrl: cdpUrl },
    {
      instruction: "Click the Apply now button",
      log,
    },
  );
  console.log("attemptStagehandFill:", { ok: result.ok, reason: result.reason, source: result.source });
  await closeStagehand();
  return { ok: result.ok, phase: "act", reason: result.reason || "" };
}

async function smokePlaywrightServer() {
  const server = await chromium.launchServer({ headless: true });
  const cdpUrl = server.wsEndpoint();
  const browser = await chromium.connect(cdpUrl);
  const page = await browser.newPage();
  await page.setContent(
    '<html><body><h1>Test job</h1><button id="apply">Apply now</button></body></html>',
  );

  let outcome;
  try {
    outcome = await smokeWithCdp({
      label: "Playwright CDP (adspower provider flag)",
      cdpUrl,
      provider: "adspower",
      page,
    });
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  return outcome;
}

async function smokeAdspower() {
  const apiUrl = (process.env.ADSPOWER_API_URL || "").replace(/\/$/, "");
  const profileId = process.env.ADSPOWER_PROFILE_ID || "";
  const apiKey = process.env.ADSPOWER_API_KEY || "";
  if (!apiUrl || !profileId) {
    return { ok: false, phase: "skip", reason: "adspower_not_configured" };
  }

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const resp = await fetch(`${apiUrl}/api/v2/browser-profile/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      profile_id: profileId,
      headless: "0",
      proxy_detection: "0",
    }),
    signal: AbortSignal.timeout(90000),
  });
  const body = await resp.json();
  if (resp.status >= 400 || body.code !== 0) {
    return { ok: false, phase: "adspower_start", reason: body.msg || JSON.stringify(body) };
  }

  const cdpUrl = body.data?.ws?.puppeteer || body.data?.ws?.selenium || "";
  if (!cdpUrl) {
    return { ok: false, phase: "adspower_start", reason: "no_cdp_url_in_response" };
  }

  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 45000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("data:text/html,<html><body><h1>Stagehand smoke</h1><button>Apply now</button></body></html>", {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  }).catch(() => {});

  let outcome;
  try {
    outcome = await smokeWithCdp({
      label: "AdsPower live CDP",
      cdpUrl,
      provider: "adspower",
      page,
    });
  } finally {
    await fetch(`${apiUrl}/api/v2/browser-profile/stop`, {
      method: "POST",
      headers,
      body: JSON.stringify({ profile_id: profileId }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => {});
    await browser.close().catch(() => {});
  }
  return outcome;
}

async function main() {
  console.log("Stagehand CDP smoke — OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "set" : "missing");

  const playwrightResult = await smokePlaywrightServer();
  console.log("\nPlaywright result:", playwrightResult);

  const adspowerResult = await smokeAdspower();
  console.log("\nAdsPower result:", adspowerResult);

  const passed =
    playwrightResult.ok ||
    (adspowerResult.ok && adspowerResult.phase !== "skip");

  if (!passed) {
    console.error("\nSMOKE FAILED — fork/plan mode recommended");
    process.exit(1);
  }
  console.log("\nSMOKE PASSED");
}

main().catch((err) => {
  console.error("SMOKE ERROR:", err);
  process.exit(1);
});
