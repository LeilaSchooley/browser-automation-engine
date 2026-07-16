import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBrowserSessionGone, isBrowserClosedError, raceUntilGone } from "../src/pageAlive.js";

describe("pageAlive", () => {
  it("treats missing page as gone", () => {
    assert.equal(isBrowserSessionGone(null), true);
    assert.equal(isBrowserSessionGone(undefined), true);
  });

  it("detects closed page", () => {
    assert.equal(isBrowserSessionGone({ isClosed: () => true }), true);
    assert.equal(isBrowserSessionGone({ isClosed: () => false, context: () => null }), false);
  });

  it("detects disconnected browser", () => {
    const page = {
      isClosed: () => false,
      context: () => ({
        browser: () => ({ isConnected: () => false }),
      }),
    };
    assert.equal(isBrowserSessionGone(page), true);
  });

  it("matches closed-target error messages", () => {
    assert.equal(isBrowserClosedError(new Error("Target page, context or browser has been closed")), true);
    assert.equal(isBrowserClosedError({ code: "BROWSER_CLOSED", message: "x" }), true);
    assert.equal(isBrowserClosedError(new Error("selector not found")), false);
  });

  it("raceUntilGone aborts when session disappears", async () => {
    let gone = false;
    const slow = new Promise((resolve) => setTimeout(() => resolve("done"), 2000));
    setTimeout(() => {
      gone = true;
    }, 50);
    await assert.rejects(() => raceUntilGone(slow, { isGone: () => gone, intervalMs: 20 }), /Browser closed/);
  });

  it("raceUntilGone resolves when work finishes first", async () => {
    const out = await raceUntilGone(Promise.resolve(42), { isGone: () => false, intervalMs: 20 });
    assert.equal(out, 42);
  });
});
