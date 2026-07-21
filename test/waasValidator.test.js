import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAuthoritativeValidation,
  waasStepCompleteFromSnap,
  isWaasHost,
} from "../src/siteAdapters/waasValidator.js";
import { isStepComplete } from "../src/layers/steppedForm.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { isLocationValueCommitted } from "../src/layers/perception/filledState.js";

describe("waasValidator", () => {
  it("detects WaaS host", () => {
    assert.equal(isWaasHost("www.workatastartup.com"), true);
    assert.equal(isWaasHost("greenhouse.io"), false);
  });

  it("reads serverErrors from data-page as incomplete", async () => {
    await withFixturePage("waas-data-page-incomplete", async (page) => {
      const v = await getAuthoritativeValidation(page);
      assert.equal(v.available, true);
      assert.ok(v.missing.includes("city_current"));
      assert.ok(v.missing.includes("us_authorized"));
      assert.equal(v.isSectionComplete, false);
    });
  });

  it("reads empty serverErrors as complete", async () => {
    await withFixturePage("waas-data-page-complete", async (page) => {
      const v = await getAuthoritativeValidation(page);
      assert.equal(v.available, true);
      assert.equal(v.missing.length, 0);
      assert.equal(v.isSectionComplete, true);
    });
  });

  it("waasStepCompleteFromSnap blocks advance when serverErrors present", () => {
    const snap = {
      url: "https://www.workatastartup.com/application/location",
      waasValidation: {
        available: true,
        missing: ["city_current", "us_authorized"],
        visibleRequiredCount: 0,
        isSectionComplete: false,
      },
      continueCandidates: [{ text: "Continue", score: 105, disabled: false }],
    };
    assert.equal(waasStepCompleteFromSnap(snap), false);
    assert.equal(isStepComplete(snap), false);
  });

  it("waasStepCompleteFromSnap allows advance when server clean", () => {
    const snap = {
      url: "https://www.workatastartup.com/application/location",
      waasValidation: {
        available: true,
        missing: [],
        visibleRequiredCount: 0,
        isSectionComplete: true,
      },
      continueCandidates: [{ text: "Continue", score: 105, disabled: false }],
    };
    assert.equal(waasStepCompleteFromSnap(snap), true);
    assert.equal(isStepComplete(snap), true);
  });

  it("blocks advance on Role step when DOM shows Required markers", async () => {
    await withFixturePage("waas-role-required", async (page) => {
      const v = await getAuthoritativeValidation(page);
      assert.ok(v.visibleRequiredCount >= 1);
      assert.equal(v.isSectionComplete, false);
      const snap = {
        url: "https://www.workatastartup.com/application/role",
        waasValidation: v,
        continueCandidates: [{ text: "Continue", score: 105, disabled: false }],
      };
      assert.equal(isStepComplete(snap), false);
    });
  });
});

describe("filledState helpers", () => {
  it("isLocationValueCommitted rejects raw search tokens", () => {
    assert.equal(isLocationValueCommitted("LONDON"), false);
    assert.equal(isLocationValueCommitted("London, UK"), true);
  });
});
