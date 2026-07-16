import { defineProfile } from "../core/profile.js";
import { ACCOUNT_WORKFLOW_SETTINGS } from "./settings.js";

export const APPLY_PROFILE = defineProfile({
  name: "apply",
  description: "Job application, ATS, resume, and human-review workflow",
  entryLabel: "Apply",
  smartFillProfile: "apply",
  intent: "submit_application",
  settings: {
    ...ACCOUNT_WORKFLOW_SETTINGS,
    listing_mode: false,
    smart_fill_profile: "apply",
    workflow_intent: "submit_application",
    auto_submit: false,
    review_mode: true,
  },
  capabilities: [
    "apply",
    "auth",
    "captcha",
    "email-verify",
    "resume-upload",
    "human-review",
  ],
});

export default APPLY_PROFILE;
