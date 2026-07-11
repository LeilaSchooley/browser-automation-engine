import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inspectPage,
  looksLikeApplyForm,
  progressScore,
  scoreEntryCandidate,
} from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";

describe("formDiscovery (unit)", () => {
  it("scores primary apply CTAs higher than nav links", () => {
    const apply = scoreEntryCandidate({
      text: "Apply",
      testId: "apply-cta",
      aria: "",
      href: "",
      inMainContent: true,
      inJobContext: true,
      inNav: false,
      inFooter: false,
      tag: "button",
      role: "button",
      area: 5000,
    });
    const nav = scoreEntryCandidate({
      text: "Search jobs",
      testId: "",
      aria: "",
      href: "/jobs",
      inMainContent: false,
      inJobContext: false,
      inNav: true,
      inFooter: false,
      tag: "a",
      role: "link",
      area: 2000,
    });
    assert.ok(apply > nav);
    assert.ok(apply >= 80);
  });

  it("recognizes apply forms by field count", () => {
    assert.equal(looksLikeApplyForm({ fieldCount: 5 }, 2), true);
    assert.equal(looksLikeApplyForm({ fieldCount: 1 }, 2), false);
  });

  it("increases progress score as fields are filled", () => {
    const snap = { pageKind: "form", fieldCount: 5, entryCount: 0, fileInputCount: 0 };
    const empty = progressScore(snap, { filled: [] });
    const partial = progressScore(snap, { filled: [{}, {}] });
    assert.ok(partial > empty);
  });
});

describe("formDiscovery (fixtures)", () => {
  it("discovers apply CTA on listing pages", async () => {
    await withFixturePage("listing-apply", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.entryCount >= 1, "expected at least one apply entry");
      assert.match(snap.entryCandidates[0].text, /apply/i);
      assert.equal(snap.pageKind, "listing");
    });
  });

  it("discovers intake form fields", async () => {
    await withFixturePage("simple-form", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.fieldCount >= 5, `expected >=5 fields, got ${snap.fieldCount}`);
      assert.equal(snap.pageKind, "form");
      assert.ok(snap.fields.some((f) => /email/i.test(f.label || f.name || f.id || "")));
    });
  });

  it("discovers cookie banner affordances", async () => {
    await withFixturePage("cookie-banner", async (page) => {
      const snap = await inspectPage(page);
      assert.equal(snap.cookieBanner, true);
      assert.ok(snap.cookieCandidates.length >= 1);
      assert.match(snap.cookieCandidates[0].text, /accept/i);
    });
  });

  it("discovers wizard modal choices", async () => {
    await withFixturePage("wizard-modal", async (page) => {
      const snap = await inspectPage(page);
      assert.equal(snap.hasApplyModal, true);
      assert.ok(snap.modalStepCount >= 1);
      assert.ok(snap.modalCandidates.some((c) => /resume/i.test(c.text)));
    });
  });

  it("discovers file upload inputs", async () => {
    await withFixturePage("file-upload", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(snap.fileInputCount >= 1, "expected file input");
      assert.ok(
        snap.fileInputCandidates.some((c) => c.testId === "resume-upload" || /file/i.test(c.selector)),
      );
    });
  });
});
