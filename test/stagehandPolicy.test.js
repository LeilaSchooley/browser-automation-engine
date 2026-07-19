import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTestRuntime } from "./helpers/runtime.js";
import {
  shouldPreferStagehand,
  buildStagehandInstruction,
  buildStagehandPlan,
  looksBoardIsh,
} from "../src/layers/stagehandPolicy.js";
import { decideWithActionBrain } from "../src/layers/actionBrain.js";
import { pathLooksLikeJobDetail, looksLikeJobBoardIndex, applyEntrySucceeded } from "../src/heuristics.js";
import { scoreEntryCandidate } from "../src/layers/formDiscovery.js";

describe("stagehandPolicy", () => {
  const ashbySnap = {
    url: "https://jobs.ashbyhq.com/ditto",
    pageText: "Open Positions",
    passwordFieldCount: 0,
    fileInputCount: 0,
    entryCount: 0,
    fieldCount: 4,
    fields: [
      { name: "departmentId", label: "Department", type: "select-one" },
      { name: "employmentType", label: "Employment Type", type: "select-one" },
      { name: "locationId", label: "Location", type: "select-one" },
      { name: "workplaceType", label: "Location Type", type: "select-one" },
    ],
  };

  const findworkDetailSnap = {
    url: "https://findwork.dev/n2YZdPX/client-delivery-manager-at-storyteller",
    title: "Client Delivery Manager at Storyteller",
    pageText: "All jobs Browse jobs Client Delivery Manager Apply for the job",
    headings: "Client Delivery Manager",
    passwordFieldCount: 0,
    fileInputCount: 0,
    entryCount: 0,
    fieldCount: 0,
    fields: [],
    interactives: [{ text: "Apply for the job", tag: "input", kind: "control" }],
  };

  it("prefers stagehand on Ashby job board when CDP is available", () => {
    initTestRuntime({ settings: { stagehand_enabled: true, agent_ai: true } });
    const classification = { step: "entry", confidence: "high", reason: "job board" };
    const context = { browserProvider: "adspower", browserCdpUrl: "ws://127.0.0.1:9222/x" };
    assert.equal(shouldPreferStagehand(ashbySnap, classification, [], context), true);
  });

  it("skips stagehand when disabled or no cdp", () => {
    initTestRuntime({ settings: { stagehand_enabled: false } });
    assert.equal(shouldPreferStagehand(ashbySnap, { step: "entry" }, [], {}), false);
    initTestRuntime({ settings: { stagehand_enabled: true } });
    assert.equal(shouldPreferStagehand(ashbySnap, { step: "entry" }, [], { browserProvider: "adspower" }), false);
  });

  it("builds job-board navigation instruction with job title", () => {
    const instruction = buildStagehandInstruction(
      ashbySnap,
      { step: "entry" },
      [],
      { job: { title: "Senior Engineer", company: "Ditto" } },
    );
    assert.match(instruction, /Senior Engineer/i);
    assert.match(instruction, /Ditto/i);
    assert.match(instruction, /filter dropdowns/i);
  });

  it("findwork-style detail: Apply instruction, never listing picker", () => {
    assert.equal(pathLooksLikeJobDetail(findworkDetailSnap), true);
    assert.equal(looksLikeJobBoardIndex(findworkDetailSnap), false);
    assert.equal(looksBoardIsh(findworkDetailSnap), false);

    const instruction = buildStagehandInstruction(
      findworkDetailSnap,
      { step: "ambiguous" },
      [],
      { job: { title: "Client Delivery Manager", company: "Storyteller" } },
    );
    assert.match(instruction, /role-specific Apply|Click the main Apply|labeled exactly/i);
    assert.doesNotMatch(instruction, /On this job board|click the job listing that best matches/i);

    const plan = buildStagehandPlan(findworkDetailSnap, { step: "entry" }, [], {
      job: { title: "Client Delivery Manager" },
    });
    assert.equal(plan.mappedTo, undefined);
  });

  it("does not treat Ashby job slug path as board index", () => {
    const detail = {
      url: "https://jobs.ashbyhq.com/ditto/client-delivery-manager",
      pageText: "Client Delivery Manager Apply",
      passwordFieldCount: 0,
      fileInputCount: 0,
      entryCount: 1,
      fieldCount: 0,
      fields: [],
      entryCandidates: [{ text: "Apply" }],
    };
    assert.equal(pathLooksLikeJobDetail(detail), true);
    assert.equal(looksLikeJobBoardIndex(detail), false);
    assert.equal(looksBoardIsh(detail), false);
  });

  it("does not force Stagehand on generic ambiguous pages", () => {
    initTestRuntime({ settings: { stagehand_enabled: true, agent_ai: true } });
    const ambiguousSnap = {
      url: "https://example.com/portal",
      pageText: "Welcome",
      passwordFieldCount: 0,
      fileInputCount: 0,
      entryCount: 0,
      fieldCount: 3,
      fields: [
        { name: "q1", label: "Question", type: "text" },
        { name: "q2", label: "Other", type: "text" },
        { name: "q3", label: "Notes", type: "text" },
      ],
    };
    const context = { browserProvider: "adspower", browserCdpUrl: "ws://127.0.0.1:9222/x" };
    assert.equal(shouldPreferStagehand(ambiguousSnap, { step: "ambiguous" }, [], context), false);
  });

  it("prefers Stagehand on ambiguous when page is board-ish", () => {
    initTestRuntime({ settings: { stagehand_enabled: true, agent_ai: true } });
    const context = { browserProvider: "adspower", browserCdpUrl: "ws://127.0.0.1:9222/x" };
    assert.equal(shouldPreferStagehand(ashbySnap, { step: "ambiguous" }, [], context), true);
  });

  it("buildStagehandPlan returns stagehand_act", () => {
    const plan = buildStagehandPlan(ashbySnap, { step: "entry", reason: "job board" }, [], {
      job: { title: "Engineer" },
      browserProvider: "adspower",
      browserCdpUrl: "ws://127.0.0.1:9222/x",
    });
    assert.equal(plan.type, "stagehand_act");
    assert.ok(plan.instruction);
    assert.equal(plan.source, "stagehand-policy");
    assert.equal(plan.mappedTo, "board_nav");
  });

  it("forceApply overrides board listing instruction", () => {
    const instruction = buildStagehandInstruction(
      ashbySnap,
      { step: "entry" },
      [],
      { job: { title: "Engineer", company: "Ditto" } },
      { forceApply: true },
    );
    assert.match(instruction, /role-specific Apply|Click the main Apply|labeled exactly/i);
    assert.doesNotMatch(instruction, /filter dropdowns/i);
  });

  it("never routes auth pages through Stagehand or social OAuth", () => {
    initTestRuntime({ settings: { stagehand_enabled: true, agent_ai: true } });
    const loginSnap = {
      url: "https://weworkremotely.com/job-seekers/account/login",
      hostname: "weworkremotely.com",
      fieldCount: 3,
      passwordFieldCount: 1,
      entryCount: 0,
      fileInputCount: 0,
      pageText: "Email Password Sign in Sign in with LinkedIn",
      interactives: [{ text: "Sign in with LinkedIn" }],
    };
    const context = { browserProvider: "adspower", browserCdpUrl: "ws://127.0.0.1:9222/x" };
    assert.equal(shouldPreferStagehand(loginSnap, { step: "ambiguous" }, [], context), false);
    const instruction = buildStagehandInstruction(loginSnap, { step: "ambiguous" }, [], {});
    assert.match(instruction, /email and password form/i);
    assert.match(instruction, /Never click.*LinkedIn/i);
    assert.doesNotMatch(instruction, /main Apply button/i);
  });

  it("action brain routes job board to stagehand-primary", async () => {
    initTestRuntime({
      settings: {
        stagehand_enabled: true,
        agent_ai: true,
        action_brain_mode: "primary",
        deterministic_first: true,
      },
      planNextAction: async () => ({ type: "click_apply", reason: "llm should not run" }),
    });
    const { plan, decision } = await decideWithActionBrain(
      ashbySnap,
      { filled: [] },
      [],
      {
        browserProvider: "adspower",
        browserCdpUrl: "ws://127.0.0.1:9222/x",
        job: { title: "Platform Engineer", company: "Ditto" },
      },
    );
    assert.equal(plan.type, "stagehand_act");
    assert.equal(decision.path, "action-catalog");
  });
});

describe("apply entry + findwork scoring", () => {
  it("scores findwork Apply-for-the-job submit above entry threshold", () => {
    const score = scoreEntryCandidate({
      text: "Apply for the job",
      tag: "input",
      type: "submit",
      inMainContent: true,
      inJobContext: true,
      pageHost: "findwork.dev",
      area: 5000,
    });
    assert.ok(score >= 20, `expected >=20, got ${score}`);
  });

  it("excludes mailto/tel links and ranks role-specific apply above generic + YC batch", () => {
    const base = { tag: "a", inMainContent: true, inJobContext: true, pageHost: "ycombinator.com", area: 5000 };
    const email = scoreEntryCandidate({ ...base, text: "email", href: "mailto:jobs@sitefire.com" });
    const role = scoreEntryCandidate({ ...base, text: "Apply to role ›", href: "/companies/sitefire/jobs/abc" });
    const generic = scoreEntryCandidate({ ...base, text: "Apply", href: "/apply" });
    const batch = scoreEntryCandidate({ ...base, text: "Apply for Fall 2026", href: "/apply" });
    assert.ok(email < 0, `mailto should be excluded, got ${email}`);
    assert.ok(role > generic, `role (${role}) should beat generic (${generic})`);
    assert.ok(role > batch, `role (${role}) should beat batch (${batch})`);
    assert.ok(batch < generic, `batch (${batch}) should be penalized below generic (${generic})`);
  });

  it("applyEntrySucceeded ignores no-progress clicks", () => {
    assert.equal(
      applyEntrySucceeded([{ action: "click_apply", ok: true, progress: false }], "fp"),
      false,
    );
    assert.equal(
      applyEntrySucceeded([{ action: "click_apply", ok: true, progress: true }], "fp"),
      true,
    );
  });
});
