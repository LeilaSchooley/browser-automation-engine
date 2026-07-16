import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPTCHA_SELECTORS,
  detectCaptcha,
  looksLikeCaptchaInSnap,
  looksLikeCaptchaReason,
} from "../src/captchaDetect.js";

describe("captchaDetect (botlord-aligned)", () => {
  it("exports CAPTCHA_SELECTORS covering reCAPTCHA / hCaptcha / CF", () => {
    assert.ok(CAPTCHA_SELECTORS.some((s) => s.includes("recaptcha")));
    assert.ok(CAPTCHA_SELECTORS.some((s) => s.includes("hcaptcha")));
    assert.ok(CAPTCHA_SELECTORS.some((s) => s.includes("challenge-form")));
  });

  it("looksLikeCaptchaReason matches hard-gate and wait_user reasons", () => {
    assert.equal(looksLikeCaptchaReason("CAPTCHA / human verification"), true);
    assert.equal(looksLikeCaptchaReason("Cloudflare turnstile checkbox"), true);
    assert.equal(looksLikeCaptchaReason("OAuth-only sign-in"), false);
  });

  it("looksLikeCaptchaInSnap uses page text + URL markers", () => {
    assert.equal(
      looksLikeCaptchaInSnap({ title: "Sign in", pageText: "Verify you are human to continue" }),
      true,
    );
    assert.equal(
      looksLikeCaptchaInSnap({ url: "https://www.google.com/sorry/index?continue=x" }),
      true,
    );
    assert.equal(
      looksLikeCaptchaInSnap({ title: "Indeed Sign In", pageText: "Email address Continue" }),
      false,
    );
  });

  it("detectCaptcha uses URL layer like botlord checkCaptchaAfterSearch", async () => {
    const page = {
      url: () => "https://www.google.com/sorry/index?continue=https://www.google.com",
      locator: () => ({
        first: () => ({
          isVisible: async () => false,
        }),
        count: async () => 0,
      }),
      evaluate: async () => false,
    };
    const hit = await detectCaptcha(page);
    assert.equal(hit.detected, true);
    assert.equal(hit.source, "url");
  });

  it("detectCaptcha finds visible widget via selectors", async () => {
    const page = {
      url: () => "https://secure.indeed.com/auth",
      locator: (sel) => ({
        first: () => ({
          isVisible: async () => sel.includes("g-recaptcha"),
        }),
        count: async () => (sel.includes("g-recaptcha") ? 1 : 0),
      }),
      evaluate: async () => false,
    };
    const hit = await detectCaptcha(page);
    assert.equal(hit.detected, true);
    assert.equal(hit.source, "dom");
  });

  it("ignores invisible recaptcha badge mounts", async () => {
    const page = {
      url: () => "https://secure.indeed.com/auth",
      locator: (sel) => ({
        first: () => ({
          isVisible: async () => false,
        }),
        count: async () => (sel.includes("recaptcha") || sel.includes("g-recaptcha") ? 1 : 0),
      }),
      evaluate: async () => false,
    };
    const hit = await detectCaptcha(page);
    assert.equal(hit.detected, false);
  });

  it("detectCaptcha uses suspectPointerBlock overlay probe", async () => {
    const page = {
      url: () => "https://secure.indeed.com/auth",
      locator: () => ({
        first: () => ({ isVisible: async () => false }),
        count: async () => 0,
      }),
      evaluate: async (fn, arg) => {
        if (Array.isArray(arg)) return false; // body phrases
        // overlay probe (no args)
        return { blocked: true, reason: "CAPTCHA / challenge overlay intercepting clicks" };
      },
    };
    const miss = await detectCaptcha(page);
    assert.equal(miss.detected, false);

    const hit = await detectCaptcha(page, { suspectPointerBlock: true });
    assert.equal(hit.detected, true);
    assert.equal(hit.source, "overlay");
  });
});
