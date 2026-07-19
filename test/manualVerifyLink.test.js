import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTestRuntime } from "./helpers/runtime.js";
import {
  normalizeVerifyLink,
  provideManualVerifyLink,
  waitForManualVerifyLink,
  cancelManualVerifyLink,
  isImapConfigured,
} from "../src/manualVerifyLink.js";

describe("manualVerifyLink", () => {
  it("normalizes pasted verification URLs", () => {
    assert.equal(
      normalizeVerifyLink('Click here: https://jobright.ai/verify?token=abc">'),
      "https://jobright.ai/verify?token=abc",
    );
  });

  it("resolves waitForManualVerifyLink when user provides URL", async () => {
    const status = [];
    initTestRuntime({
      settings: { email_imap_host: "", email_imap_user: "", email_imap_pass: "" },
      onStatus: (_id, payload) => status.push(payload),
    });

    const wait = waitForManualVerifyLink(42, { timeoutMs: 5000 });
    assert.equal(isImapConfigured(), false);
    assert.equal(status.at(-1)?.phase, "verify_email");
    assert.equal(status.at(-1)?.needs_verify_link, true);

    assert.equal(provideManualVerifyLink(42, "https://example.com/confirm?x=1"), true);
    const link = await wait;
    assert.equal(link, "https://example.com/confirm?x=1");
  });

  it("accepts a link pasted before the verification waiter starts", async () => {
    initTestRuntime({ settings: {} });
    assert.equal(provideManualVerifyLink(99, "https://example.com/activate?token=early"), true);
    const link = await waitForManualVerifyLink(99, { timeoutMs: 5000 });
    assert.equal(link, "https://example.com/activate?token=early");
  });

  it("cancelManualVerifyLink rejects pending wait", async () => {
    initTestRuntime({ settings: {} });
    const wait = waitForManualVerifyLink(7, { timeoutMs: 5000 });
    cancelManualVerifyLink(7, "stopped");
    await assert.rejects(wait, /stopped/);
  });
});
