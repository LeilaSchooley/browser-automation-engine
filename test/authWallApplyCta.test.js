import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectAuthWallFromSnap, historySaysAccountExists } from "../src/patterns/authWall.js";
import { needsApplyCtaDiscovery } from "../src/layers/applyCta.js";
import { looksLikeSteppedForm } from "../src/layers/steppedForm.js";

describe("authWall detector", () => {
  it("detects WWR-style register wall", () => {
    const snap = {
      url: "https://weworkremotely.com/job-seekers/account/register?alert=Create+an+account",
      pageText: "Create an account to view full job details. Email Password Continue",
      authForm: true,
      signupForm: true,
      passwordFieldCount: 1,
      emailFieldCount: 1,
      fieldCount: 3,
      continueCount: 1,
    };
    const s = detectAuthWallFromSnap(snap);
    assert.equal(s.isAuthWall, true);
    assert.equal(s.isRegister, true);
    assert.ok(["auth_url", "password_form", "strong_auth_surface"].includes(s.reason));
  });

  it("detects already-exists / switch to sign-in on real auth URL", () => {
    const snap = {
      url: "https://weworkremotely.com/job-seekers/account",
      pageText: "Account already exists. Please switch to sign in.",
      authForm: true,
      passwordFieldCount: 1,
      emailFieldCount: 1,
    };
    const s = detectAuthWallFromSnap(snap);
    assert.equal(s.isAuthWall, true);
    assert.equal(s.alreadyExists, true);
    assert.equal(historySaysAccountExists([{ existingAccount: true }]), true);
  });

  it("ignores Findwork job listing (no false auth wall)", () => {
    const snap = {
      url: "https://findwork.dev/nYPLjBX/strategic-sourcing-specialist-at-jll",
      pageKind: "listing",
      pageText:
        "Strategic Sourcing Specialist at JLL. Apply for the job. Job description and responsibilities.",
      entryCount: 1,
      fieldCount: 1,
      passwordFieldCount: 0,
      emailFieldCount: 0,
      entryCandidates: [{ text: "Apply for the job", score: 78 }],
    };
    const s = detectAuthWallFromSnap(snap);
    assert.equal(s.isAuthWall, false);
    assert.equal(s.reason, "job_listing");
  });

  it("does not treat auth forms as apply wizards", () => {
    assert.equal(
      looksLikeSteppedForm({
        url: "https://weworkremotely.com/job-seekers/account/register",
        continueCount: 1,
        fieldCount: 3,
        passwordFieldCount: 1,
        emailFieldCount: 1,
        authForm: true,
        signupForm: true,
      }),
      false,
    );
  });
});

describe("applyCta zero-field discovery", () => {
  it("flags WaaS job detail with 0 fields as needing CTA", () => {
    assert.equal(
      needsApplyCtaDiscovery({
        url: "https://www.workatastartup.com/jobs/98761",
        pageKind: "content",
        fieldCount: 0,
        bodyTextLength: 12800,
        entryCount: 0,
      }),
      true,
    );
  });

  it("does not flag auth walls as Apply CTA pages", () => {
    assert.equal(
      needsApplyCtaDiscovery({
        url: "https://weworkremotely.com/job-seekers/account",
        pageKind: "auth",
        fieldCount: 3,
        passwordFieldCount: 1,
        emailFieldCount: 1,
        authForm: true,
      }),
      false,
    );
  });
});
