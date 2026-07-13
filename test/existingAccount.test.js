import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyApplyStep } from "../src/layers/applyStep.js";
import {
  looksLikeExistingAccount,
  looksLikeExistingAccountError,
  looksLikeExistingAccountSignInPrompt,
  looksLikeAuthFailure,
} from "../src/layers/authActions.js";

describe("existing account detection", () => {
  it("detects email already registered toast as error (not generic auth failure)", () => {
    const snap = {
      title: "Sign up",
      pageText: "That email is already registered. Please sign in.",
      pageKind: "form",
      fieldCount: 2,
      signInCount: 1,
      signInCandidates: [{ text: "Sign in" }],
    };
    assert.equal(looksLikeExistingAccount(snap), true);
    assert.equal(looksLikeExistingAccountError(snap), true);
    assert.equal(looksLikeAuthFailure(snap), false);
  });

  it("detects Already have an account? Sign in prompt", () => {
    const snap = {
      title: "Create account",
      pageText: "Already have an account? Sign in",
      signInCount: 1,
      signInCandidates: [{ text: "Sign in" }],
      signUpCount: 1,
    };
    assert.equal(looksLikeExistingAccountSignInPrompt(snap), true);
  });

  it("routes to signin_entry when stored credentials and already-account CTA", () => {
    const snap = {
      title: "Create account",
      pageText: "Already have an account? Sign in",
      hostname: "jobs.example.com",
      signInCount: 1,
      signInCandidates: [{ text: "Sign in" }],
      signUpCount: 1,
    };
    const c = classifyApplyStep(snap, { filled: [] }, [], {
      auth: { email: "a@b.com", password: "x" },
      profile: { email: "a@b.com" },
    });
    assert.equal(c.step, "signin_entry");
  });

  it("routes to auth after signup history reports existingAccount", () => {
    const snap = {
      title: "Sign In",
      pageText: "Email Password Sign in",
      pageKind: "form",
      fieldCount: 2,
      emailFieldCount: 1,
      passwordFieldCount: 1,
      authForm: true,
      signInCount: 0,
    };
    const c = classifyApplyStep(
      snap,
      { filled: [] },
      [{ action: "auth_signup", ok: false, existingAccount: true }],
      { auth: { email: "a@b.com", password: "x" } },
    );
    assert.equal(c.step, "auth");
  });

  it("routes to signin_entry on email-already-registered error even without prior history", () => {
    const snap = {
      title: "Sign up",
      pageText: "An account with this email already exists",
      signInCount: 1,
      signInCandidates: [{ text: "Log in" }],
      passwordFieldCount: 0,
    };
    const c = classifyApplyStep(snap, { filled: [] }, [], null);
    assert.equal(c.step, "signin_entry");
  });
});
