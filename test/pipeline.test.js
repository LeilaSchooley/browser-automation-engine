import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { runPipeline } from "../src/layers/runPipeline.js";
import { runSmartFill } from "../src/smartFill.js";
import { withFixturePage, readFixture } from "./helpers/fixtures.js";
import { quietLog } from "./helpers/log.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("runSmartFill (Node wrapper)", () => {
  it("fills fields via Playwright using buildFillConfig", async () => {
    initTestRuntime({
      settings: { smart_fill_passes: 2, browser_human_behavior: false },
      buildFillConfig: async () => ({
        fullName: "Acme Labs",
        email: "founder@acme.dev",
        websiteUrl: "https://acme.dev",
        tagline: "Ship faster",
        description: "We help startups list everywhere.",
        startupName: "Acme Labs",
      }),
    });

    await withFixturePage("simple-form", async (page) => {
      const result = await runSmartFill(page, { startupName: "Acme Labs" }, quietLog());
      assert.ok(result.filled.length >= 2, `expected fills, got ${result.filled.length}`);
      assert.equal(await page.inputValue("#email"), "founder@acme.dev");
      assert.equal(await page.inputValue("#website"), "https://acme.dev");
    });
  });

  it("dedupes selectors across multi-pass fills", async () => {
    initTestRuntime({
      settings: { smart_fill_passes: 3, browser_human_behavior: false },
      buildFillConfig: async () => ({
        email: "a@b.co",
        websiteUrl: "https://acme.dev",
        startupName: "Acme",
      }),
    });

    await withFixturePage("simple-form", async (page) => {
      const result = await runSmartFill(page, {}, quietLog());
      const selectors = result.filled.map((f) => f.selector).filter(Boolean);
      assert.equal(selectors.length, new Set(selectors).size);
    });
  });
});

describe("runPipeline (agent disabled)", () => {
  let server;
  let baseUrl;

  before(async () => {
    const html = readFixture("simple-form");
    server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("runs linear prep → smart fill and returns ready message", async () => {
    initTestRuntime({
      settings: {
        agent_enabled: false,
        browser_human_behavior: false,
        cloudflare_wait_enabled: false,
        smart_fill_passes: 1,
      },
      buildFillConfig: async () => ({
        email: "founder@acme.dev",
        websiteUrl: "https://acme.dev",
        startupName: "Acme Labs",
        tagline: "Ship",
        description: "Desc",
      }),
    });

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      const result = await runPipeline(page, {
        url: baseUrl,
        context: {},
        log: quietLog(),
      });

      assert.equal(result.agentSteps, 0);
      assert.ok(Array.isArray(result.agentHistory));
      assert.equal(result.agentHistory.length, 0);
      assert.ok(result.snap.fieldCount >= 5);
      assert.ok(result.fillResult.filled.length >= 2);
      assert.match(result.readyMessage, /Filled \d+ field/);
      assert.equal(result.cloudflare, false);
    } finally {
      await browser.close();
    }
  });
});
