import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import { decideNextAction, runAutomationAgent } from "../src/layers/automationAgent.js";
import {
  clickDiscoveredContinue,
  clickDiscoveredEntry,
  clickDiscoveredModalStep,
  uploadDiscoveredFile,
} from "../src/layers/domActions.js";
import { runPagePrepRound } from "../src/layers/pagePrep.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { pageFingerprintFromSnap } from "../src/heuristics.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { quietLog } from "./helpers/log.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("agent actions (fixture clicks)", () => {
  it("accepts cookies and clears the banner", async () => {
    initTestRuntime();
    await withFixturePage("cookie-banner", async (page) => {
      const before = await inspectPage(page);
      assert.equal(before.cookieBanner, true);

      const round = await runPagePrepRound(page, "https://example.com/job", quietLog(), {
        mode: "cookies",
      });
      assert.ok(round.actions.includes("cookies"));

      const after = await inspectPage(page);
      assert.equal(after.cookieBanner, false);
      assert.equal(await page.locator("#onetrust-banner-sdk").count(), 0);
    });
  });

  it("clicks listing Apply and reveals the form", async () => {
    initTestRuntime();
    await withFixturePage("listing-apply", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.entryCount >= 1);

      const ok = await clickDiscoveredEntry(page, quietLog(), "agent", snap);
      assert.equal(ok, true);
      assert.equal(await page.locator("#apply-panel").isVisible(), true);
      assert.ok((await inspectPage(page)).fieldCount >= 2);
    });
  });

  it("clicks wizard resume choice and reveals file input", async () => {
    initTestRuntime();
    await withFixturePage("wizard-modal", async (page) => {
      const snap = await inspectPage(page);
      assert.equal(snap.hasApplyModal, true);

      const result = await clickDiscoveredModalStep(page, quietLog(), "agent", snap);
      assert.equal(result.ok, true);
      assert.equal(await page.locator("#upload-step").isVisible(), true);
      assert.ok((await inspectPage(page)).fileInputCount >= 1);
    });
  });

  it("clicks Continue and reveals the next step", async () => {
    initTestRuntime();
    await withFixturePage("continue-step", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.continueCount >= 1);

      const ok = await clickDiscoveredContinue(page, quietLog(), "agent", snap);
      assert.equal(ok, true);
      assert.equal(await page.locator("#email").isVisible(), true);
    });
  });

  it("uploads a resume via discovered file input", async () => {
    const tmp = path.join(os.tmpdir(), `engine-resume-${Date.now()}.pdf`);
    fs.writeFileSync(tmp, "%PDF-1.4 test resume");
    initTestRuntime({
      resolveFileUpload: async () => ({ ok: true, path: tmp }),
    });

    try {
      await withFixturePage("file-upload", async (page) => {
        const snap = await inspectPage(page);
        const ok = await uploadDiscoveredFile(page, quietLog(), "agent", snap);
        assert.equal(ok, true);
        assert.match(await page.locator("#status").innerText(), /attached/i);
      });
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("runs a short agent loop: listing → click_apply → form", async () => {
    initTestRuntime({
      settings: { agent_max_steps: 3 },
      buildFillConfig: async () => ({
        email: "founder@acme.dev",
        fullName: "Ada Lovelace",
      }),
    });

    await withFixturePage("listing-apply", async (page) => {
      const result = await runAutomationAgent(page, {}, quietLog(), {
        url: "https://example.com/job",
      });
      assert.ok(result.history.some((h) => h.action === "click_apply" && h.ok));
      assert.ok(result.snap.fieldCount >= 2 || result.fillResult.filled.length > 0);
    });
  });
});

describe("stuck recovery", () => {
  it("forces upload_resume when stuck with upload affordance", async () => {
    initTestRuntime({ settings: { agent_ai: false } });

    const snap = {
      pageKind: "modal",
      fieldCount: 0,
      fileInputCount: 1,
      entryCount: 0,
      modalStepCount: 0,
      hasApplyModal: true,
      cookieBanner: false,
      continueCount: 0,
      submitCount: 0,
      fileInputCandidates: [{ selector: "#resume", testId: "resume-upload" }],
      modalCandidates: [],
      title: "Upload",
      url: "https://example.com/apply",
      bodyTextLength: 80,
    };
    const fp = pageFingerprintFromSnap(snap);
    const history = [
      { action: "click_modal", fingerprint: fp, ok: false, progress: false },
      { action: "click_modal", fingerprint: fp, ok: false, progress: false },
      { action: "click_modal", fingerprint: fp, ok: false, progress: false },
    ];

    const { plan, classification } = await decideNextAction(snap, { filled: [] }, history, {});
    assert.equal(plan?.type, "upload_resume");
    assert.match(plan?.source, /stuck-recovery|action-catalog/);
    assert.ok(classification);
  });
});
