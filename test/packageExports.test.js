import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/** Additive modular exports plus the historical root/smart-fill surface. */
const REQUIRED_EXPORTS = [
  ".",
  "./core",
  "./profiles",
  "./profiles/apply",
  "./profiles/directory",
  "./profiles/generic",
  "./smart-fill",
];

/** Frozen createEngine instance keys — removals fail CI. */
const CREATE_ENGINE_KEYS = [
  "apply",
  "applyStorageStateToContext",
  "buildReadyMessage",
  "cancelManualVerifyLink",
  "capabilities",
  "classifyApplyStep",
  "computeApplyOutcome",
  "createAgent",
  "createLogger",
  "detectCaptcha",
  "fieldHintsFromFilled",
  "gotoWithCloudflareRetry",
  "hasPendingManualVerifyLink",
  "humanGoto",
  "humanPause",
  "inspectPage",
  "isCloudflarePage",
  "isImapConfigured",
  "loadAccountForHost",
  "loadSiteAccounts",
  "loadSiteLearnings",
  "loadSiteMappings",
  "loadStorageState",
  "looksLikeCaptchaInSnap",
  "looksLikeCaptchaReason",
  "normalizeVerifyLink",
  "outcomeJobStatus",
  "preparePageForApply",
  "profile",
  "provideManualVerifyLink",
  "recordLearningsFromRun",
  "recordPipelineOutcome",
  "recordSiteLearning",
  "resolveAccountForHost",
  "run",
  "runApplyAgent",
  "runAutomationAgent",
  "runPipeline",
  "runSmartFill",
  "saveStorageState",
  "settings",
  "stepToPlan",
  "synthesizeLearningsFromRun",
  "waitForCaptchaClear",
  "waitForCloudflareClear",
];

/** Core root named exports that must never disappear. */
const ROOT_REQUIRED_NAMES = [
  "DEFAULT_SETTINGS",
  "authPatterns",
  "createAgentCore",
  "createApplyEngine",
  "createDirectoryEngine",
  "createEngine",
  "createGenericEngine",
  "createLogger",
  "defineProfile",
  "initRuntime",
  "patterns",
  "resolveProfile",
  "runPipeline",
  "runSmartFill",
];

function resolveExportTarget(subpath) {
  const entry = pkg.exports?.[subpath];
  assert.ok(entry, `missing package export "${subpath}"`);
  if (typeof entry === "string") return path.join(root, entry);
  const target = entry.import || entry.default;
  assert.ok(target, `export "${subpath}" has no import/default target`);
  return path.join(root, target);
}

describe("package exports", () => {
  it("keeps required subpaths pointing at real files", () => {
    for (const subpath of REQUIRED_EXPORTS) {
      const target = resolveExportTarget(subpath);
      assert.equal(fs.existsSync(target), true, `missing file for ${subpath}: ${target}`);
    }
  });

  it("preserves root named exports and createEngine shape", async () => {
    const rootEntry = resolveExportTarget(".");
    const api = await import(pathToFileURL(rootEntry).href);
    for (const name of ROOT_REQUIRED_NAMES) {
      assert.ok(name in api, `missing root export: ${name}`);
    }
    assert.equal(api.authPatterns, api.patterns);

    const engine = api.createEngine({});
    assert.deepEqual(Object.keys(engine).sort(), [...CREATE_ENGINE_KEYS].sort());
    assert.equal(engine.profile.name, "legacy");
  });

  it("exposes modular core and profile entrypoints", async () => {
    const core = await import(pathToFileURL(resolveExportTarget("./core")).href);
    assert.equal(typeof core.createAgentCore, "function");
    assert.equal(typeof core.defineProfile, "function");

    const profiles = await import(pathToFileURL(resolveExportTarget("./profiles")).href);
    assert.equal(profiles.resolveProfile("apply").name, "apply");
    assert.equal(profiles.resolveProfile("directory").name, "directory");

    const apply = await import(pathToFileURL(resolveExportTarget("./profiles/apply")).href);
    assert.equal(typeof apply.createApplyEngine, "function");
    assert.equal(apply.profile.name, "apply");

    const directory = await import(pathToFileURL(resolveExportTarget("./profiles/directory")).href);
    assert.equal(typeof directory.createDirectoryEngine, "function");
    assert.equal(directory.profile.name, "directory");
  });

  it("keeps smart-fill as a script-style vendor file", () => {
    const smartFill = fs.readFileSync(resolveExportTarget("./smart-fill"), "utf8");
    assert.match(smartFill, /function\s+runSmartFill\s*\(/);
    assert.match(smartFill, /window\.runSmartFill/);
  });
});
