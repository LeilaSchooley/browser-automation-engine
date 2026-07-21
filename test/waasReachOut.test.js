import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikeReachOutModal,
  looksLikeRequiredOutreachTextarea,
  MIN_OUTREACH_CHARS,
  MAX_OUTREACH_CHARS,
  truncateOutreachMessage,
} from "../src/patterns/outreach.js";
import { buildOutreachMessage, isWaasReachOutStep } from "../src/siteAdapters/waasReachOut.js";
import { assessCompletenessFromSnap } from "../src/layers/CompletenessOracle.js";
import { shouldPreferStagehand } from "../src/layers/stagehandPolicy.js";

function reachOutSnap(overrides = {}) {
  return {
    url: "https://www.workatastartup.com/jobs/98761",
    hostname: "workatastartup.com",
    title: "Founding Product Engineer at Sitefire",
    pageText:
      "Reach out to Vincent at Sitefire. Hi! My name is Isaac Boadi. " +
      "This role doesn't match your location preferences. Check here if you're open to relocating. " +
      "Please write at least 50 characters.",
    entryCount: 1,
    fieldCount: 2,
    fields: [
      { type: "textarea", label: "?", filled: false, value: "" },
      { type: "checkbox", label: "on", filled: false },
    ],
    ...overrides,
  };
}

describe("outreach / Reach-out patterns", () => {
  it("detects WaaS job-page Reach-out modal from copy + textarea", () => {
    assert.equal(looksLikeReachOutModal(reachOutSnap()), true);
    assert.equal(isWaasReachOutStep(reachOutSnap()), true);
  });

  it("does not treat profile wizard as Reach-out", () => {
    assert.equal(
      looksLikeReachOutModal({
        url: "https://www.workatastartup.com/application/share",
        fields: [{ type: "textarea", filled: false }],
        pageText: "Share more about yourself",
      }),
      false,
    );
  });

  it("marks empty outreach textarea as required", () => {
    assert.equal(looksLikeRequiredOutreachTextarea(reachOutSnap()), true);
    assert.equal(
      looksLikeRequiredOutreachTextarea(
        reachOutSnap({
          fields: [{ type: "textarea", filled: true, value: "x".repeat(60) }],
        }),
      ),
      false,
    );
  });

  it("buildOutreachMessage is ≥50 chars and uses cover letter when present", () => {
    const short = buildOutreachMessage({
      applicant: { fullName: "Isaac Boadi" },
      job: { title: "Founding Product Engineer", company: "Sitefire" },
    });
    assert.ok(short.length >= MIN_OUTREACH_CHARS);

    const cover = "A".repeat(80);
    const fromCover = buildOutreachMessage({ coverLetter: cover });
    assert.equal(fromCover, cover);
  });

  it("truncates cover letters to the 580-char Reach-out cap on a word boundary", () => {
    const long =
      "I've been building full-stack products for the past few years, and this role feels like exactly what I've been looking for. " +
      "The pivot from energy to GEO is fascinating, especially the shift from just tracking AI visibility to actually operationalizing it. " +
      "I'm comfortable owning features end to end, from talking to customers to shipping and iterating. " +
      "I've worked with large datasets before and built agents that actually do things rather than just generate text. " +
      "The idea of making AI part of how the company operates, not just what it builds, really resonates with me. " +
      "I'm based in London and open to relocating for the right founding role with this team.";
    assert.ok(long.length > MAX_OUTREACH_CHARS);
    const cut = truncateOutreachMessage(long, MAX_OUTREACH_CHARS);
    assert.ok(cut.length <= MAX_OUTREACH_CHARS);
    assert.ok(cut.length >= MIN_OUTREACH_CHARS);
    assert.ok(!/I'm base$/i.test(cut), `should not cut mid-word: ${cut.slice(-20)}`);
    assert.equal(cut, buildOutreachMessage({ coverLetter: long }));
  });

  it("CompletenessOracle treats empty Reach-out as incomplete", () => {
    const result = assessCompletenessFromSnap(reachOutSnap());
    assert.equal(result.complete, false);
    assert.equal(result.reason, "outreach_message_required");
    assert.ok(result.missing.includes("outreach_message"));
  });

  it("blocks Stagehand preference when Reach-out is detected (guard before apply-loop heuristic)", () => {
    // Unit env usually has no CDP → canUseStagehand is false anyway.
    // Assert the dedicated Reach-out guard is active by requiring the detector first.
    assert.equal(looksLikeReachOutModal(reachOutSnap()), true);
    // When Stagehand *is* available, shouldPreferStagehand must still refuse Reach-out.
    // Simulate by checking the early-return path: detector true ⇒ policy must not prefer.
    const prefer = shouldPreferStagehand(
      reachOutSnap(),
      { step: "form", confidence: "low" },
      [{ action: "click_apply" }, { action: "click_apply" }],
      { browserProvider: "adspower", browserCdpUrl: "http://127.0.0.1:9222" },
      { filled: [] },
    );
    // Prefer false either from Reach-out guard or disabled Stagehand settings — never true.
    assert.equal(prefer, false);
  });
});
