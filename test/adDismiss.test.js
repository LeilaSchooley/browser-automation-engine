import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dismissInterstitialDialog, dismissBlockingOverlays } from "../src/layers/adDismiss.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { quietLog } from "./helpers/log.js";

describe("adDismiss interstitial fixtures", () => {
  it("dismisses first Skip in upsell chain", async () => {
    await withFixturePage("upsell-chain", async (page) => {
      const before = await inspectPage(page);
      assert.ok(before.hasBlockingOverlay || before.modalCount > 0 || before.pageKind !== "form");

      const ok = await dismissInterstitialDialog(page, quietLog(), "test");
      assert.equal(ok, true);
      assert.equal(await page.locator("#modal-2").isVisible(), true);
      assert.equal(await page.locator("#modal-1").isVisible(), false);
    });
  });

  it("chains dismiss through Skip to application", async () => {
    await withFixturePage("upsell-chain", async (page) => {
      const ok = await dismissBlockingOverlays(page, quietLog(), "test");
      assert.equal(ok, true);
      assert.equal(await page.locator("#apply-form").isVisible(), true);
      assert.equal(await page.locator("[role=dialog]:visible").count(), 0);
      const after = await inspectPage(page);
      assert.ok(after.fieldCount >= 2);
    });
  });

  it("dismisses generic survey modal via No thanks", async () => {
    await withFixturePage("generic-survey-modal", async (page) => {
      const ok = await dismissBlockingOverlays(page, quietLog(), "test");
      assert.equal(ok, true);
      assert.equal(await page.locator("#form").isVisible(), true);
      const after = await inspectPage(page);
      assert.ok(after.fieldCount >= 2);
    });
  });

  it("dismisses expert review gate via Skip and continue", async () => {
    await withFixturePage("expert-review-gate", async (page) => {
      const ok = await dismissInterstitialDialog(page, quietLog(), "test");
      assert.equal(ok, true);
      assert.equal(await page.locator("#apply-form").isVisible(), true);
      const after = await inspectPage(page);
      assert.ok(after.fieldCount >= 2);
    });
  });

  it("dismisses JobLeads resume score gate via Skip free expert review card", async () => {
    await withFixturePage("resume-score-gate", async (page) => {
      const before = await inspectPage(page);
      assert.match(before.pageText || "", /36\/100 resume score/i);

      const ok = await dismissInterstitialDialog(page, quietLog(), "test");
      assert.equal(ok, true);
      assert.equal(await page.locator("#apply-form").isVisible(), true);
      const after = await inspectPage(page);
      assert.ok(after.fieldCount >= 2);
    });
  });
});
