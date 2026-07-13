import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entryHrefScoreDelta,
  isChromeErrorPage,
  isOauthProviderHost,
  isQueueableApplyUrl,
  isSocialSsoCta,
  isSuspiciousApplyHost,
  looksLikeAggregatorTrap,
  looksLikeDeadApplyDestination,
  shouldBlockApplyNavigation,
} from "../src/layers/applyUrlSafety.js";
import { classifyApplyStep } from "../src/layers/applyStep.js";
import { scoreEntryCandidate } from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { adoptOpenedPage } from "../src/layers/pageReady.js";

describe("applyUrlSafety", () => {
  it("detects chrome error pages", () => {
    assert.equal(isChromeErrorPage("chrome-error://chromewebdata/", "careersprint.7f.liveblog365.com"), true);
    assert.equal(isChromeErrorPage("https://boards.greenhouse.io/acme/jobs/1", "Apply"), false);
  });

  it("flags suspicious apply hosts", () => {
    assert.equal(isSuspiciousApplyHost("careersprint.7f.liveblog365.com"), true);
    assert.equal(isSuspiciousApplyHost("jobs.lever.co"), false);
  });

  it("detects Apple/Google SSO hosts and social CTAs", () => {
    assert.equal(isOauthProviderHost("https://appleid.apple.com/auth/authorize?client_id=com.indeed.secure"), true);
    assert.equal(isOauthProviderHost("accounts.google.com"), true);
    assert.equal(isOauthProviderHost("https://secure.indeed.com/auth"), false);
    assert.equal(isOauthProviderHost("https://www.linkedin.com/jobs/view/1"), false);
    assert.equal(isSocialSsoCta("Continue with Apple"), true);
    assert.equal(isSocialSsoCta("Continue"), false);
  });

  it("hard-stops classifyApplyStep on Apple SSO pages", () => {
    const c = classifyApplyStep(
      {
        url: "https://appleid.apple.com/auth/authorize?client_id=com.indeed.secure",
        hostname: "appleid.apple.com",
        title: "Sign in to Apple Account",
        pageKind: "auth",
        fieldCount: 2,
        emailFieldCount: 1,
        passwordFieldCount: 1,
        pageText: "Sign in to Apple Account",
      },
      { filled: [] },
    );
    assert.equal(c.step, "blocked");
    assert.equal(c.hardStop, true);
    assert.match(c.reason, /SSO|Apple|email Continue/i);
  });

  it("adoptOpenedPage closes Apple SSO popups and keeps Indeed auth", async () => {
    const closed = [];
    const indeed = {
      isClosed: () => false,
      url: () => "https://secure.indeed.com/auth?from=indapply",
      context: () => context,
      bringToFront: async () => {},
      close: async () => {
        throw new Error("should not close Indeed tab");
      },
    };
    const apple = {
      isClosed: () => closed.includes("apple"),
      url: () =>
        "https://appleid.apple.com/auth/authorize?client_id=com.indeed.secure&redirect_uri=https%3A%2F%2Fsecure.indeed.com",
      waitForLoadState: async () => {},
      title: async () => "Sign in to Apple Account",
      bringToFront: async () => {},
      close: async () => {
        closed.push("apple");
        list = list.filter((p) => p !== apple);
      },
    };
    let list = [indeed, apple];
    const context = {
      pages: () => list.filter((p) => !p.isClosed()),
    };
    const known = new Set([indeed]);
    const adopted = await adoptOpenedPage(indeed, known, { layer() {} });
    assert.equal(adopted, null);
    assert.deepEqual(closed, ["apple"]);
    assert.equal(list.length, 1);
    assert.equal(list[0], indeed);
  });

  it("blocks navigation to suspicious hosts", () => {
    const block = shouldBlockApplyNavigation(
      "https://careersprint.7f.liveblog365.com/job/2366132",
      "https://remote.thetodayupdate.com/job/x/",
    );
    assert.equal(block.block, true);
  });

  it("rejects aggregator and suspicious hosts from apply queues", () => {
    assert.equal(
      isQueueableApplyUrl("https://remote.thetodayupdate.com/job/123").queueable,
      false,
    );
    assert.equal(
      isQueueableApplyUrl("https://careersprint.7f.liveblog365.com/job/1").queueable,
      false,
    );
    assert.equal(isQueueableApplyUrl("https://frontendnode-production3.up.railway.app/job/x").queueable, false);
    assert.equal(isQueueableApplyUrl("https://jobs.lever.co/acme/123").queueable, true);
  });

  it("rejects Jooble /jdp SEO listings at queue time", () => {
    const check = isQueueableApplyUrl("https://jooble.org/jdp/9177318897283547463");
    assert.equal(check.queueable, false);
    assert.match(check.reason, /jooble|aggregator/i);
  });

  it("rejects Jooble closedJob SearchResult URLs", () => {
    const check = isQueueableApplyUrl(
      "https://jooble.org/SearchResult?closedJob=True&ukw=junior%20developer",
    );
    assert.equal(check.queueable, false);
    assert.match(check.reason, /closed|search results/i);
  });

  it("classifies dead chrome-error snapshot as blocked", () => {
    const c = classifyApplyStep(
      {
        url: "chrome-error://chromewebdata/",
        title: "careersprint.7f.liveblog365.com",
        pageKind: "unknown",
        fieldCount: 0,
        entryCount: 0,
        bodyTextLength: 122,
      },
      { filled: [] },
    );
    assert.equal(c.step, "blocked");
    assert.equal(c.hardStop, true);
    assert.match(c.reason, /unreachable/i);
  });

  it("penalizes custom-button external apply links when native apply exists", () => {
    const custom = scoreEntryCandidate({
      text: "Apply Job!",
      className: "custom-button",
      href: "https://remotejobs.victorytuitions.in/job/x",
      tag: "a",
      role: "link",
      inMainContent: true,
      inJobContext: true,
      pageHost: "remote.thetodayupdate.com",
      hasNativeApplyButton: true,
      area: 5000,
    });
    const native = scoreEntryCandidate({
      text: "Apply Now",
      className: "btn btn-apply btn-apply-job-internal-without-login",
      href: "#job-apply-form",
      tag: "a",
      role: "link",
      inMainContent: true,
      inJobContext: true,
      pageHost: "remote.thetodayupdate.com",
      hasNativeApplyButton: true,
      area: 5000,
    });
    assert.ok(native > custom, `native=${native} should beat custom=${custom}`);
  });

  it("penalizes input submit disguised as apply CTA", () => {
    const inputSubmit = scoreEntryCandidate({
      text: "Apply for the job",
      tag: "input",
      inMainContent: true,
      inJobContext: true,
      pageHost: "findwork.dev",
      area: 5000,
    });
    const button = scoreEntryCandidate({
      text: "Apply now",
      tag: "button",
      inMainContent: true,
      inJobContext: true,
      pageHost: "findwork.dev",
      area: 5000,
    });
    assert.ok(button > inputSubmit, `button=${button} should beat input=${inputSubmit}`);
  });

  it("detects Firefox Server Not Found pages", () => {
    assert.equal(
      looksLikeDeadApplyDestination({
        url: "about:neterror?e=dnsNotFound&u=https%3A//careersprint.7f.liveblog365.com/",
        title: "Server Not Found",
        pageText: "Firefox can't connect to the server at careersprint.7f.liveblog365.com.",
        pageKind: "unknown",
        fieldCount: 0,
        entryCount: 0,
        bodyTextLength: 120,
      }).dead,
      true,
    );
  });

  it("detects aggregator trap when all apply links are toxic", () => {
    const trap = looksLikeAggregatorTrap(
      {
        url: "https://remotejobs.victorytuitions.in/job/x",
        hostname: "remotejobs.victorytuitions.in",
        fieldCount: 0,
        entryCandidates: [
          { text: "Apply To This Job", href: "https://careersprint.7f.liveblog365.com/job/2366132" },
        ],
      },
      [],
    );
    assert.equal(trap.trapped, true);
  });
});

describe("applyUrlSafety (fixtures)", () => {
  it("prefers native apply over custom-button mirror link", async () => {
    await withFixturePage("aggregator-mirror-apply", async (page) => {
      const snap = await inspectPage(page);
      assert.equal(snap.hasNativeApplyButton, true);
      assert.ok(snap.entryCount >= 1);
      const top = snap.entryCandidates[0];
      assert.match(top.text, /apply now/i);
      assert.ok(!/custom-button/i.test(top.className || ""));
    });
  });
});

describe("looksLikeDeadApplyDestination", () => {
  it("marks chrome error as dead", () => {
    const dead = looksLikeDeadApplyDestination({
      url: "chrome-error://chromewebdata/",
      title: "careersprint.7f.liveblog365.com",
      pageKind: "unknown",
      fieldCount: 0,
      entryCount: 0,
    });
    assert.equal(dead.dead, true);
  });
});
