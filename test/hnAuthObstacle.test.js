import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, before, after } from "node:test";
import { initTestRuntime } from "./helpers/runtime.js";
import { classifyApplyStep, stepToPlan } from "../src/layers/applyStep.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { attemptObstacleRecovery } from "../src/layers/obstacleActions.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { quietLog } from "./helpers/log.js";

let accountsFile = "";

before(() => {
  accountsFile = path.join(os.tmpdir(), `ql-hn-accounts-${process.pid}.json`);
  initTestRuntime({
    settings: {
      auto_signup_enabled: true,
      site_accounts_path: accountsFile,
      account_email_base: "founder@agency.example",
      listing_mode: true,
      objective_mode: true,
    },
  });
});

after(() => {
  if (accountsFile && fs.existsSync(accountsFile)) fs.unlinkSync(accountsFile);
});

const profileContext = {
  profile: {
    startupName: "Acme Labs",
    founderName: "Jane Doe",
    email: "founder@agency.example",
  },
  sessionId: "sub-hn-1",
};

describe("HN login wall + obstacles", () => {
  it("detects username auth and classifies as signup", async () => {
    await withFixturePage("hn-login-wall", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.usernameFieldCount >= 1, "expected username fields");
      assert.ok(snap.passwordFieldCount >= 1);
      assert.equal(snap.authForm, true);
      assert.equal(snap.signupForm, true);

      const context = { ...profileContext };
      const c = classifyApplyStep(snap, { filled: [] }, [], context);
      assert.equal(c.step, "signup");
      assert.equal(stepToPlan(c, snap, [])?.type, "auth_signup");
      assert.ok(context.auth?.username || context.auth?.password);
    });
  });

  it("checks required terms checkbox as obstacle", async () => {
    await withFixturePage("checkbox-gate", async (page) => {
      const snap = await inspectPage(page);
      const before = await page.locator('input[name="terms"]').isChecked();
      assert.equal(before, false);
      const result = await attemptObstacleRecovery(page, snap, quietLog());
      assert.equal(result.ok, true);
      assert.equal(result.action, "checkbox");
      assert.equal(await page.locator('input[name="terms"]').isChecked(), true);
    });
  });
});
