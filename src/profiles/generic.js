import { defineProfile } from "../core/profile.js";

export const GENERIC_PROFILE = defineProfile({
  name: "generic",
  description: "Conservative domain-neutral browser task workflow",
  entryLabel: "Continue",
  smartFillProfile: "all",
  intent: "complete_task",
  settings: {
    listing_mode: false,
    smart_fill_profile: "all",
    workflow_intent: "complete_task",
    auto_submit: false,
    review_mode: false,
    auto_signup_enabled: false,
    email_verify_enabled: false,
    network_skills_enabled: false,
  },
  capabilities: ["forms", "custom-controls", "captcha", "navigation"],
});

export default GENERIC_PROFILE;
