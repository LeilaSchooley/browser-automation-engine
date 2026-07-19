/**
 * Apply-voyage regression suite — WebVoyager-style fixtures for job-apply paths.
 * Unit-level: scoring, OTP classification, Stagehand naming, progress gates.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreEntryCandidate } from "../src/layers/formDiscovery.js";
import { classifyApplyStep } from "../src/layers/applyStep.js";
import { looksLikeSoftOtpGate, looksLikePasswordlessLoginSurface } from "../src/layers/authActions.js";
import { buildStagehandInstruction } from "../src/layers/stagehandPolicy.js";
import {
  computeMechanicalSignals,
  isStrongMechanicalProgress,
} from "../src/layers/actionValidator.js";
import { generateTotpCode } from "../src/totp.js";
import { normalizeVerifyCode } from "../src/manualVerifyCode.js";
import { roleNameMatcher, stripDecorativeGlyphs } from "../src/primitives/safeLocator.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("apply voyages — findwork / YC / WWR / Ashby style", () => {
  it("findwork: Apply-for-the-job submit clears entry threshold", () => {
    const score = scoreEntryCandidate({
      text: "Apply for the job",
      tag: "input",
      type: "submit",
      inMainContent: true,
      inJobContext: true,
      pageHost: "findwork.dev",
      area: 5000,
    });
    assert.ok(score >= 20, `expected >=20, got ${score}`);
  });

  it("YC: role Apply beats generic + batch + mailto", () => {
    const base = {
      tag: "a",
      inMainContent: true,
      inJobContext: true,
      pageHost: "ycombinator.com",
      area: 5000,
    };
    const email = scoreEntryCandidate({ ...base, text: "email", href: "mailto:jobs@sitefire.com" });
    const role = scoreEntryCandidate({ ...base, text: "Apply to role ›", href: "/companies/sitefire/jobs/abc" });
    const generic = scoreEntryCandidate({ ...base, text: "Apply", href: "/apply" });
    const batch = scoreEntryCandidate({ ...base, text: "Apply for Fall 2026", href: "/apply" });
    assert.ok(email < 0);
    assert.ok(role > generic);
    assert.ok(role > batch);
  });

  it("YC account: passwordless + soft OTP classifies enter_otp / signup_entry", () => {
    initTestRuntime({
      settings: { auto_signup_enabled: true, account_email_base: "founder@agency.example" },
    });
    const otpSnap = {
      title: "Log in to access the YC Application",
      headings: "Log in to access the YC Application",
      pageText: "Or enter the code from your email: Verify Code",
      hostname: "account.ycombinator.com",
      fieldCount: 1,
      passwordFieldCount: 0,
      emailFieldCount: 0,
      usernameFieldCount: 1,
      fields: [{ type: "text", label: "Or enter the code from your email:", name: "code" }],
      continueCandidates: [{ text: "Verify Code" }],
      signUpCount: 1,
      signUpCandidates: [{ text: "Create an account" }],
    };
    assert.equal(looksLikeSoftOtpGate(otpSnap), true);
    const otpClass = classifyApplyStep(otpSnap, { filled: [] }, [], {
      profile: { email: "founder@agency.example" },
    });
    assert.equal(otpClass.step, "enter_otp");

    const loginSnap = {
      title: "Log in to access the YC Application",
      headings: "Log in to access the YC Application",
      hostname: "account.ycombinator.com",
      fieldCount: 1,
      passwordFieldCount: 0,
      usernameFieldCount: 1,
      continueCandidates: [{ text: "Continue" }],
      signUpCount: 1,
      signUpCandidates: [{ text: "Create an account" }],
    };
    assert.equal(looksLikePasswordlessLoginSurface(loginSnap), true);
    const loginClass = classifyApplyStep(loginSnap, { filled: [] }, [], {
      profile: { email: "founder@agency.example", startupName: "TestCo" },
    });
    assert.equal(loginClass.step, "signup_entry");
  });

  it("Stagehand apply instruction names top entry CTA", () => {
    const snap = {
      entryCandidates: [{ text: "Apply to role ›", href: "/jobs/1" }],
      url: "https://www.ycombinator.com/companies/sitefire/jobs/abc",
      hostname: "ycombinator.com",
      entryCount: 1,
      fieldCount: 0,
      passwordFieldCount: 0,
      fileInputCount: 0,
    };
    const instruction = buildStagehandInstruction(
      snap,
      { step: "entry", forceApply: true },
      [],
      { job: { title: "Founding Product Engineer", company: "Sitefire" } },
    );
    assert.match(instruction, /Apply to role/);
    assert.doesNotMatch(instruction, /click the job listing that best matches/i);
  });

  it("progress: fingerprint churn on OTP wall is not strong progress", () => {
    const before = {
      url: "https://account.ycombinator.com/?continue=x",
      hostname: "account.ycombinator.com",
      title: "Account | Y Combinator",
      pageText: "Username or email",
      fieldCount: 1,
    };
    const after = {
      url: "https://account.ycombinator.com/?continue=x",
      hostname: "account.ycombinator.com",
      title: "Account | Y Combinator",
      pageText: "Or enter the code from your email:",
      fieldCount: 1,
    };
    const signals = computeMechanicalSignals(before, after, {});
    // Force stillOnAuthOrOtp
    signals.stillOnAuthOrOtp = true;
    signals.fingerprintChanged = true;
    assert.equal(
      isStrongMechanicalProgress(signals, true, true, { type: "click_continue" }),
      false,
    );
  });

  it("decorative chevron in CTA still matches the bare accessible name", () => {
    assert.equal(stripDecorativeGlyphs("Apply to role ›"), "Apply to role");
    const re = roleNameMatcher("Apply to role ›");
    // Must match both the bare a11y name and the glyph-suffixed variant…
    assert.match("Apply to role", re);
    assert.match("Apply to role ›", re);
    // …but not the generic "Apply" that sits next to it on YC job pages.
    assert.doesNotMatch("Apply", re);
  });

  it("YC login card with generic title still detects passwordless (pageText fallback)", () => {
    // Real YC surface: title="Account | Y Combinator", headings unrendered, tiny card body.
    const snap = {
      title: "Account | Y Combinator",
      headings: "",
      pageText:
        "Log in to access the YC Application Username or email Continue Don't have an account? Create an account Trouble signing in? Log in with email magic link",
      hostname: "account.ycombinator.com",
      fieldCount: 1,
      passwordFieldCount: 0,
      emailFieldCount: 1,
      usernameFieldCount: 0,
      continueCandidates: [{ text: "Continue" }],
      signUpCount: 1,
      signUpCandidates: [{ text: "Create an account" }],
    };
    assert.equal(looksLikePasswordlessLoginSurface(snap), true);
    initTestRuntime({
      settings: { auto_signup_enabled: true, account_email_base: "founder@agency.example" },
    });
    const cls = classifyApplyStep(snap, { filled: [] }, [], {
      profile: { email: "founder@agency.example", startupName: "TestCo" },
    });
    assert.equal(cls.step, "signup_entry");
  });

  it("YC signup form routes to signup path (not generic profile fill)", () => {
    initTestRuntime({
      settings: { auto_signup_enabled: true, account_email_base: "founder@agency.example" },
    });
    const snap = {
      title: "Sign up to access the YC Application",
      headings: "Sign up to access the YC Application",
      pageText: "Sign up to access the YC Application",
      hostname: "account.ycombinator.com",
      fieldCount: 5,
      passwordFieldCount: 1,
      emailFieldCount: 1,
      usernameFieldCount: 1,
      signUpCount: 1,
      signUpCandidates: [{ text: "Sign Up" }],
      fields: [
        { type: "text", label: "First Name", name: "first_name" },
        { type: "text", label: "Last Name", name: "last_name" },
        { type: "email", label: "Email", name: "email" },
        { type: "text", label: "Username", name: "username" },
        { type: "password", label: "Password", name: "password" },
      ],
    };
    const cls = classifyApplyStep(snap, { filled: [] }, [], {
      profile: { email: "founder@agency.example", fullName: "Isaac Boadi", startupName: "TestCo" },
    });
    assert.equal(cls.step, "signup");
  });

  it("TOTP generates 6-digit codes; OTP normalize strips junk", () => {
    // RFC test vector-ish: any valid base32 should yield 6 digits
    const code = generateTotpCode("JBSWY3DPEHPK3PXP", { now: 1_700_000_000_000 });
    assert.match(code, /^\d{6}$/);
    assert.equal(normalizeVerifyCode("Your code is 482913"), "482913");
    assert.equal(normalizeVerifyCode("abc"), "");
  });
});
