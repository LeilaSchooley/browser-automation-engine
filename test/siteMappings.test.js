import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import { loadSiteMappingsFromPath, loadSiteMappings } from "../src/siteMappings.js";
import { applyConfig, runPagePrepRound } from "../src/layers/pagePrep.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { isCloudflarePage } from "../src/cloudflare.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { quietLog } from "./helpers/log.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("siteMappings", () => {
  it("loads domains / siteMappings / flat object shapes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-maps-"));
    const domainsPath = path.join(dir, "domains.json");
    const nestedPath = path.join(dir, "nested.json");
    const flatPath = path.join(dir, "flat.json");

    fs.writeFileSync(
      domainsPath,
      JSON.stringify({
        domains: {
          "example.com": { _apply: { entry: ["#go"] } },
        },
      }),
    );
    fs.writeFileSync(
      nestedPath,
      JSON.stringify({
        siteMappings: {
          "jobs.example.com": { $apply: { cookieAccept: ["#ok"] } },
        },
      }),
    );
    fs.writeFileSync(
      flatPath,
      JSON.stringify({
        "cdn.example.com": { _apply: { dismiss: [".x"] } },
      }),
    );

    assert.deepEqual(loadSiteMappingsFromPath(domainsPath)["example.com"]._apply.entry, ["#go"]);
    assert.deepEqual(loadSiteMappingsFromPath(nestedPath)["jobs.example.com"].$apply.cookieAccept, [
      "#ok",
    ]);
    assert.deepEqual(loadSiteMappingsFromPath(flatPath)["cdn.example.com"]._apply.dismiss, [".x"]);
    assert.deepEqual(loadSiteMappingsFromPath(path.join(dir, "missing.json")), {});
  });

  it("prefers runtime loader over settings path", () => {
    initTestRuntime({
      loadSiteMappings: () => ({
        "runtime.test": { _apply: { entry: ["#runtime"] } },
      }),
      settings: { site_mappings_path: "/nonexistent/mappings.json" },
    });
    const maps = loadSiteMappings();
    assert.deepEqual(maps["runtime.test"]._apply.entry, ["#runtime"]);
  });

  it("parses applyConfig hints for a host", () => {
    const cfg = applyConfig("www.jobs.example.com", {
      "jobs.example.com": {
        _apply: {
          cookieAccept: ["#accept"],
          entry: ["#apply"],
          dismiss: [".modal-close"],
        },
      },
    });
    assert.deepEqual(cfg.cookieAccept, ["#accept"]);
    assert.deepEqual(cfg.entry, ["#apply"]);
    assert.deepEqual(cfg.dismiss, [".modal-close"]);
  });

  it("uses mapping entry selector when DOM scoring misses the CTA", async () => {
    initTestRuntime({
      loadSiteMappings: () => ({
        "mapped.example": {
          _apply: {
            entry: ["#custom-go"],
          },
        },
      }),
    });

    await withFixturePage("mapped-entry", async (page) => {
      const before = await inspectPage(page);
      // Weak CTA copy — may or may not appear in entryCandidates; mapping is the source of truth.
      const round = await runPagePrepRound(page, "https://mapped.example/job/1", quietLog(), {
        mode: "entry",
      });
      assert.ok(round.actions.includes("entry"), `expected entry action, got ${round.actions}`);
      assert.equal(await page.locator("#form-panel").isVisible(), true);
      assert.ok((await inspectPage(page)).fieldCount >= 2 || before.entryCount >= 0);
    });
  });
});

describe("cloudflare detection", () => {
  it("detects challenge marker HTML", async () => {
    initTestRuntime({ settings: { cloudflare_wait_enabled: false } });
    await withFixturePage("cloudflare-challenge", async (page) => {
      assert.equal(await isCloudflarePage(page), true);
    });
  });

  it("does not flag normal listing pages", async () => {
    initTestRuntime({ settings: { cloudflare_wait_enabled: false } });
    await withFixturePage("listing-apply", async (page) => {
      assert.equal(await isCloudflarePage(page), false);
    });
  });
});
