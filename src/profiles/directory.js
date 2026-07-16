import { defineProfile } from "../core/profile.js";
import { ACCOUNT_WORKFLOW_SETTINGS } from "./settings.js";

export const DIRECTORY_PROFILE = defineProfile({
  name: "directory",
  description: "Directory listing, product submission, and account onboarding workflow",
  entryLabel: "Submit",
  smartFillProfile: "directory",
  intent: "submit_listing",
  settings: {
    ...ACCOUNT_WORKFLOW_SETTINGS,
    listing_mode: true,
    smart_fill_profile: "directory",
    workflow_intent: "submit_listing",
    auto_submit: false,
    review_mode: false,
    network_skills_enabled: true,
  },
  capabilities: [
    "directory",
    "auth",
    "captcha",
    "email-verify",
    "network-skills",
  ],
});

export default DIRECTORY_PROFILE;
