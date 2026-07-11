import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTestRuntime } from "./helpers/runtime.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { resolveStartUrl } from "../src/layers/runPipeline.js";
import { classifyApplyStep } from "../src/layers/applyStep.js";
import { withFixturePage } from "./helpers/fixtures.js";

describe("listing entry discovery", () => {
  it("resolveStartUrl prefers concrete submit paths", () => {
    assert.equal(
      resolveStartUrl("https://news.ycombinator.com/", "https://news.ycombinator.com/submit"),
      "https://news.ycombinator.com/submit",
    );
    assert.equal(
      resolveStartUrl("https://news.ycombinator.com/", "https://news.ycombinator.com/"),
      "https://news.ycombinator.com/",
    );
  });

  it("prefers top submit nav over footer Apply to YC on HN-style pages", async () => {
    initTestRuntime({ settings: { listing_mode: true } });
    await withFixturePage("hackernews-home", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.entryCount >= 1, "expected at least one listing entry");
      const top = snap.entryCandidates[0];
      assert.match(top.text, /submit/i);
      assert.doesNotMatch(top.text, /apply to yc/i);

      const c = classifyApplyStep(snap, { filled: [] }, [], null);
      assert.equal(c.step, "entry");
      assert.match(c.reason, /submit/i);
    });
  });
});
