import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consentFailedTwice,
  isNonCookiePopup,
  looksLikeRealCookieConsent,
  topCookieCandidateScore,
} from "../src/consentDetection.js";
import {
  isDeterministicState,
  shouldInvokeLlm,
} from "../src/layers/deterministicPolicy.js";
import { pageFingerprintFromSnap } from "../src/heuristics.js";

describe("consentDetection", () => {
  it("looksLikeRealCookieConsent accepts scored accept button", () => {
    const snap = {
      cookieBanner: true,
      cookieCandidates: [{ text: "Accept all cookies", score: 90 }],
      fieldCount: 0,
      pageText: "We use cookies",
    };
    assert.equal(looksLikeRealCookieConsent(snap), true);
    assert.equal(topCookieCandidateScore(snap), 90);
  });

  it("looksLikeRealCookieConsent rejects job-alert popup", () => {
    const snap = {
      cookieBanner: true,
      fieldCount: 7,
      modalCount: 1,
      pageText: "Be the first to know Receive the Latest Jobs",
      fields: [
        { label: "Email Address", type: "email" },
        { label: "Receive the Latest Jobs", type: "submit" },
      ],
      cookieCandidates: [{ text: "Receive the Latest Jobs", score: 70 }],
    };
    assert.equal(isNonCookiePopup(snap), true);
    assert.equal(looksLikeRealCookieConsent(snap), false);
  });

  it("looksLikeRealCookieConsent accepts structural OneTrust chrome", () => {
    const snap = {
      structuralCookieBanner: true,
      cookieBanner: true,
      cookieCandidates: [{ text: "Accept", score: 45 }],
      pageText: "Privacy",
      fieldCount: 0,
    };
    assert.equal(looksLikeRealCookieConsent(snap), true);
  });

  it("consentFailedTwice after two no-progress accept_cookies", () => {
    const snap = { pageKind: "consent", fieldCount: 0 };
    const fp = pageFingerprintFromSnap(snap);
    const history = [
      { action: "accept_cookies", fingerprint: fp, ok: true, progress: false },
      { action: "accept_cookies", fingerprint: fp, ok: true, progress: false },
    ];
    assert.equal(consentFailedTwice(history, fp), true);
  });
});

describe("deterministicPolicy consent", () => {
  const cookieSnap = {
    cookieBanner: true,
    structuralCookieBanner: true,
    cookieCandidates: [{ text: "Accept all cookies", score: 90 }],
    fieldCount: 0,
    entryCount: 0,
    pageText: "cookies",
  };

  it("consent is deterministic only with high confidence and real cookie UI", () => {
    const classification = {
      step: "consent",
      confidence: "high",
      fingerprint: pageFingerprintFromSnap(cookieSnap),
    };
    assert.equal(isDeterministicState(classification, cookieSnap, null, []), true);
  });

  it("consent is not deterministic with medium confidence", () => {
    const classification = {
      step: "consent",
      confidence: "medium",
      fingerprint: pageFingerprintFromSnap(cookieSnap),
    };
    assert.equal(isDeterministicState(classification, cookieSnap, null, []), false);
    assert.equal(shouldInvokeLlm(classification, cookieSnap, null, []), true);
  });

  it("consent is not deterministic after two failed attempts", () => {
    const fp = pageFingerprintFromSnap(cookieSnap);
    const classification = {
      step: "consent",
      confidence: "high",
      fingerprint: fp,
    };
    const history = [
      { action: "accept_cookies", fingerprint: fp, ok: true, progress: false },
      { action: "accept_cookies", fingerprint: fp, ok: true, progress: false },
    ];
    assert.equal(isDeterministicState(classification, cookieSnap, null, history), false);
    assert.equal(shouldInvokeLlm(classification, cookieSnap, null, history), true);
  });
});
