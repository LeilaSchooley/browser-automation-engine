import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scoreEntryCandidate,
  scoreListingEntryCandidate,
  scoreSignInCandidate,
  serializeCandidateScoringForPage,
} from "../src/layers/perception/candidateScoring.js";

describe("candidateScoring", () => {
  it("apply-to-role beats batch apply", () => {
    const base = {
      tag: "a",
      inMainContent: true,
      inJobContext: true,
      pageHost: "ycombinator.com",
      area: 5000,
    };
    const role = scoreEntryCandidate({
      ...base,
      text: "Apply to role ›",
      href: "/companies/sitefire/jobs/abc",
    });
    const batch = scoreEntryCandidate({
      ...base,
      text: "Apply for Fall 2026",
      href: "/apply",
    });
    assert.ok(role > batch, `expected role (${role}) > batch (${batch})`);
  });

  it("mailto gets very negative", () => {
    const score = scoreEntryCandidate({
      text: "email",
      href: "mailto:jobs@example.com",
      tag: "a",
      inMainContent: true,
      pageHost: "example.com",
      area: 5000,
    });
    assert.ok(score <= -300, `expected <= -300, got ${score}`);
  });

  it("sign-in magic link scores 0", () => {
    assert.equal(
      scoreSignInCandidate({ text: "Log in with email magic link", tag: "button" }),
      0,
    );
    assert.ok(scoreSignInCandidate({ text: "Sign in with email", tag: "button" }) > 100);
  });

  it("listing Submit scores high", () => {
    const score = scoreListingEntryCandidate(
      {
        text: "Submit",
        testId: "",
        aria: "",
        href: "/submit",
        tag: "a",
        role: "link",
        inMainContent: true,
        inNav: true,
      },
      "news.ycombinator.com",
    );
    assert.ok(score >= 200, `expected >= 200, got ${score}`);
  });

  it("serializeCandidateScoringForPage exposes in-page helpers", () => {
    const { helperJs } = serializeCandidateScoringForPage();
    assert.match(helperJs, /function scoreListingEntry\b/);
    assert.match(helperJs, /function scoreEntry\b/);
    assert.match(helperJs, /function scoreSignInButton\b/);
    assert.match(helperJs, /function scoreSignUpButton\b/);
  });
});
