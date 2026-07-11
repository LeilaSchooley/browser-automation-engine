import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzePageIntent,
  rankEntryCandidates,
  normalizeHost,
} from "../src/layers/pageIntent.js";

describe("pageIntent", () => {
  it("flags off-domain navigation as wrong", () => {
    const intent = analyzePageIntent(
      {
        url: "https://www.ycombinator.com/apply/",
        hostname: "www.ycombinator.com",
        title: "Apply to YC | Y Combinator",
        pageText: "apply to yc batch accelerator program",
        fieldCount: 0,
        entryCount: 1,
        pageKind: "listing",
      },
      { targetHost: "news.ycombinator.com", submitUrl: "https://news.ycombinator.com/submit" },
    );
    assert.equal(intent.wrongPage, true);
    assert.match(intent.wrongReason, /left target site|accelerator/i);
  });

  it("scores submit surfaces positively", () => {
    const intent = analyzePageIntent(
      {
        url: "https://news.ycombinator.com/submit",
        hostname: "news.ycombinator.com",
        title: "Submit",
        pageText: "submit url title",
        fieldCount: 3,
        pageKind: "form",
      },
      { targetHost: "news.ycombinator.com" },
    );
    assert.equal(intent.wrongPage, false);
    assert.ok(intent.onSubmitSurface);
  });

  it("ranks submit nav above apply-to-yc footer links", () => {
    const ranked = rankEntryCandidates(
      [
        { text: "Apply to YC", score: 40, href: "https://www.ycombinator.com/apply/" },
        { text: "submit", score: 50, href: "/submit" },
      ],
      { targetHost: normalizeHost("news.ycombinator.com") },
    );
    assert.match(ranked[0].text, /submit/i);
  });
});
