import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it } from "node:test";
import {
  looksLikeHideFromCompanies,
  looksLikeSponsorship,
  looksLikeWorkAuth,
  looksLikeRemote,
  looksLikeRelocate,
  looksLikeRelocateLocations,
  looksLikePolicyAck,
  normalizeRemotePreference,
  remoteAnswerForPreference,
  SCREENING_LABEL_TO_MAPPED,
  HIDE_COMPANIES_FIELD_KEYWORDS,
  getHideFromCompaniesValue,
} from "../src/patterns/applicationScreening.js";
import { mapApplicationLabelToMapped } from "../src/primitives/controlPatterns.js";
import { resolveApplicationAnswer, getApplicationAnswers } from "../src/fillApplicationAnswers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMART_FILL_JS = fs.readFileSync(path.join(__dirname, "../src/smart_fill.js"), "utf8");

describe("applicationScreening patterns (site-agnostic)", () => {
  it("detects common ATS screening question phrasings", () => {
    assert.ok(looksLikeWorkAuth("Are you legally authorized to work in the United States?"));
    assert.ok(
      looksLikeSponsorship(
        "Do you require visa sponsorship to work legally in the United States (now or in the future)?",
      ),
    );
    assert.ok(looksLikeRemote("Are you open to working remotely?"));
    assert.ok(looksLikeRelocate("Are you willing to relocate?"));
    assert.ok(looksLikeRelocateLocations("Where else would you relocate? (cities, regions, countries, etc.)"));
    assert.equal(looksLikeRelocate("Where else would you relocate? (cities, regions, countries, etc.)"), false);
    assert.ok(
      looksLikeHideFromCompanies(
        "Are there companies you want to be hidden from? (e.g. your current employer)",
      ),
    );
    assert.ok(
      looksLikePolicyAck(
        "Do you understand that we are unable to sponsor an employment Visa at this time?",
      ),
    );
  });

  it("maps labels via SCREENING_LABEL_TO_MAPPED without host-specific names", () => {
    assert.equal(mapApplicationLabelToMapped("legally authorized to work")?.mappedTo, "workauthorization");
    assert.equal(mapApplicationLabelToMapped("require visa sponsorship")?.mappedTo, "visasponsorship");
    assert.equal(mapApplicationLabelToMapped("open to working remotely")?.mappedTo, "remotepreference");
    assert.equal(mapApplicationLabelToMapped("willing to relocate")?.mappedTo, "willingtorelocate");
    assert.equal(
      mapApplicationLabelToMapped("companies you want to be hidden from")?.mappedTo,
      "hidecompanies",
    );
    assert.ok(SCREENING_LABEL_TO_MAPPED.every((e) => e.mappedTo && e.re));
  });

  it("resolves remote preference keys to ATS option text", () => {
    assert.equal(normalizeRemotePreference("only"), "only");
    assert.equal(remoteAnswerForPreference("open"), "I'm open to working remotely");
    assert.equal(
      resolveApplicationAnswer("remotepreference", "remote?", { preferences: { remotePreference: "no" } }),
      "I don't want to work remotely",
    );
  });

  it("returns hide-from value from preferences, never invents a name", () => {
    assert.equal(
      getHideFromCompaniesValue({ preferences: { hideFromCompanies: "Acme" } }),
      "Acme",
    );
    assert.equal(
      resolveApplicationAnswer("hidecompanies", "hidden from", {
        applicant: { fullName: "Isaac Boadi" },
      }),
      "",
    );
    assert.equal(
      getApplicationAnswers({ preferences: { hideFromCompanies: "Acme Corp" } }).hideFromCompanies,
      "Acme Corp",
    );
  });

  it("keeps smart_fill hidecompanies keywords aligned with the screening module", () => {
    for (const kw of HIDE_COMPANIES_FIELD_KEYWORDS) {
      assert.ok(
        SMART_FILL_JS.includes(`"${kw}"`) || SMART_FILL_JS.includes(`'${kw}'`),
        `smart_fill.js missing keyword ${kw}`,
      );
    }
  });
});
