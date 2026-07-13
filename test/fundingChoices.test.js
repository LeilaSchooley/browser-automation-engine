import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptFundingChoicesConsent, fundingChoicesVisible } from "../src/layers/fundingChoices.js";
import { clickDiscoveredCookie } from "../src/layers/domActions.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { inspectPage } from "../src/layers/formDiscovery.js";

describe("fundingChoices", () => {
  it("detects fc-consent-root overlay", async () => {
    await withFixturePage("funding-choices-consent", async (page) => {
      assert.equal(await fundingChoicesVisible(page), true);
    });
  });

  it("clicks Consent and dismisses overlay", async () => {
    await withFixturePage("funding-choices-consent", async (page) => {
      const log = { layer: () => {} };
      assert.equal(await acceptFundingChoicesConsent(page, log, "test"), true);
      assert.equal(await fundingChoicesVisible(page), false);
    });
  });

  it("clickDiscoveredCookie handles funding choices", async () => {
    await withFixturePage("funding-choices-consent", async (page) => {
      const log = { layer: () => {} };
      const ok = await clickDiscoveredCookie(page, log, "test");
      assert.ok(ok);
      const snap = await inspectPage(page);
      assert.equal(snap.cookieBanner, false);
    });
  });
});
