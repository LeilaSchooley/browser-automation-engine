import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyApplyUrlHealth,
  looksLikeScrapedMirrorUrl,
  probeApplyUrlReachability,
} from "../src/layers/applyUrlHealth.js";

describe("applyUrlHealth", () => {
  it("flags google jobs mirror funnel URLs on free hosts", () => {
    const url =
      "https://careersprint.7f.liveblog365.com/job/2060344?utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic";
    const mirror = looksLikeScrapedMirrorUrl(url);
    assert.equal(mirror.mirror, true);
    assert.match(mirror.reason, /mirror|google jobs/i);
  });

  it("classifies liveblog365 careersprint as not ok without probe", async () => {
    const url = "https://careersprint.7f.liveblog365.com/job/2060344";
    const health = await classifyApplyUrlHealth(url, { probe: false });
    assert.equal(health.ok, false);
    assert.match(health.reason, /suspicious|mirror/i);
  });

  it("treats probe network failures as unreachable", async () => {
    const health = await probeApplyUrlReachability("https://careersprint.7f.liveblog365.com/job/2060344", {
      fetchImpl: async () => {
        const err = new Error("fetch failed");
        err.cause = { code: "ENOTFOUND" };
        throw err;
      },
    });
    assert.equal(health.reachable, false);
    assert.match(health.reason, /unreachable|ENOTFOUND/i);
  });

  it("allows real ATS URLs", async () => {
    const health = await classifyApplyUrlHealth("https://boards.greenhouse.io/acme/jobs/1", {
      probe: false,
    });
    assert.equal(health.ok, true);
  });
});
