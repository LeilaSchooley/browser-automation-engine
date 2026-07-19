import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, before, after } from "node:test";
import { initTestRuntime } from "./helpers/runtime.js";
import { classifyApplyStep, stepToPlan } from "../src/layers/applyStep.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";
import {
  generateAccountCredentials,
  loadAccountForHost,
  resolveAccountForHost,
  saveAccountForHost,
} from "../src/accountStore.js";

let accountsFile = "";

before(() => {
  accountsFile = path.join(os.tmpdir(), `ql-accounts-${process.pid}.json`);
  initTestRuntime({
    settings: {
      auto_signup_enabled: true,
      site_accounts_path: accountsFile,
      account_email_base: "founder@agency.example",
    },
  });
});

after(() => {
  if (accountsFile && fs.existsSync(accountsFile)) fs.unlinkSync(accountsFile);
});

const profileContext = {
  profile: {
    startupName: "Acme",
    founderName: "Jane Doe",
    email: "founder@agency.example",
  },
  sessionId: "sub-test-1",
};

describe("account store", () => {
  it("uses the exact email by default", () => {
    const creds = generateAccountCredentials({
      emailBase: "founder@agency.example",
      hostname: "betalist.com",
      label: "acme",
    });
    assert.equal(creds.email, "founder@agency.example");
    assert.ok(creds.password.length >= 12);
  });

  it("generates plus-addressed credentials when aliases are enabled", () => {
    const creds = generateAccountCredentials({
      emailBase: "founder@agency.example",
      hostname: "betalist.com",
      label: "acme",
      useEmailAlias: true,
    });
    assert.match(creds.email, /^founder\+ql-betalist-com-/);
    assert.ok(creds.password.length >= 12);
  });

  it("persists and reloads host accounts", () => {
    saveAccountForHost("example.com", { email: "a@b.c", password: "secret" });
    const loaded = loadAccountForHost("example.com");
    assert.equal(loaded.email, "a@b.c");
  });

  it("provisions on first resolve", () => {
    const account = resolveAccountForHost(profileContext, "newdir.com");
    assert.ok(account?.email);
    assert.equal(account.isNew, true);
    const again = resolveAccountForHost(profileContext, "newdir.com");
    assert.equal(again.email, account.email);
    assert.equal(again.isNew, false);
  });
});

describe("signup flow", () => {
  it("detects signup form fields", async () => {
    await withFixturePage("betalist-signup", async (page) => {
      const snap = await inspectPage(page);
      assert.equal(snap.signupForm, true);
      assert.ok(snap.confirmPasswordFieldCount >= 1);
      assert.ok(snap.signUpCount >= 1);
    });
  });

  it("classifies signup form as auth_signup when auto-signup enabled", async () => {
    await withFixturePage("betalist-signup", async (page) => {
      const snap = await inspectPage(page);
      const context = { ...profileContext, auth: undefined };
      const c = classifyApplyStep(snap, { filled: [] }, [], context);
      assert.equal(c.step, "signup");
      assert.equal(stepToPlan(c, snap, [])?.type, "auth_signup");
      assert.ok(context.auth?.email);
    });
  });

  it("detects signup entry on login page", async () => {
    await withFixturePage("betalist-login", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.signUpCount >= 1);
      const context = { ...profileContext, auth: undefined };
      const c = classifyApplyStep(snap, { filled: [] }, [], context);
      assert.equal(c.step, "signup_entry");
      assert.equal(stepToPlan(c, snap, [])?.type, "click_signup");
    });
  });

  it("prefers login when shared credentials exist", async () => {
    await withFixturePage("betalist-login", async (page) => {
      const snap = await inspectPage(page);
      const context = {
        auth: { email: "founder@testco.example", password: "test-password-123" },
        profile: { email: "founder@testco.example" },
      };
      const c = classifyApplyStep(snap, { filled: [] }, [], context);
      assert.equal(c.step, "auth");
      assert.equal(stepToPlan(c, snap, [])?.type, "auth_login");
    });
  });
});
