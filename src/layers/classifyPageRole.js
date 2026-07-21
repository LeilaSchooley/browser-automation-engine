/**
 * Modular page-role classifier — route auth / otp / profile / reach-out / apply / job form.
 * Snap-first (fast); optional live page enrichment later.
 */
import { detectAuthWallFromSnap } from "../patterns/authWall.js";
import { detectProfileSetupFromSnap } from "../patterns/profileSetup.js";
import { looksLikeReachOutModal } from "../patterns/outreach.js";
import { detectOtpFromSnap } from "../patterns/otpDetect.js";
import { needsApplyCtaDiscovery } from "./applyCta.js";
import { looksLikeJobApplicationPage } from "../platformOnboarding.js";

/**
 * @typedef {'otp'|'auth_wall'|'profile_setup'|'reach_out'|'job_application'|'job_detail'|'unknown'} PageRole
 */

/**
 * @param {object} snap
 * @param {object} [context]
 * @returns {{ role: PageRole, reason: string, detail?: object }}
 */
export function classifyPageRoleFromSnap(snap, context = {}) {
  if (!snap) return { role: "unknown", reason: "no_snap" };

  // OTP / passcode before auth or form — digit boxes must never become smart_fill.
  const otp = detectOtpFromSnap(snap);
  if (otp.isOtp) {
    return { role: "otp", reason: otp.reason, detail: otp };
  }

  const auth = detectAuthWallFromSnap(snap);
  if (auth.isAuthWall) {
    return { role: "auth_wall", reason: auth.reason, detail: auth };
  }

  if (looksLikeReachOutModal(snap)) {
    return { role: "reach_out", reason: "reach_out_modal" };
  }

  const profile = detectProfileSetupFromSnap(snap);
  if (profile.isProfileSetup) {
    return { role: "profile_setup", reason: profile.reason, detail: profile };
  }

  if (needsApplyCtaDiscovery(snap)) {
    return { role: "job_detail", reason: "zero_field_or_job_detail" };
  }

  if (looksLikeJobApplicationPage(snap) || (snap.fieldCount || 0) >= 4) {
    const body = `${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
    if (/submit application|apply for this job|cover letter|eeoc/i.test(body) || (snap.fileInputCount || 0) > 0) {
      return { role: "job_application", reason: "apply_form_signals" };
    }
  }

  if ((snap.entryCount || 0) > 0 && (snap.fieldCount || 0) <= 1 && snap.pageKind === "listing") {
    return { role: "job_detail", reason: "listing_entry" };
  }

  if ((snap.fieldCount || 0) >= 2 || (snap.customControls || []).length > 0) {
    return { role: "job_application", reason: "form_fields", detail: { contextHost: context?.targetHost } };
  }

  return { role: "unknown", reason: "no_match" };
}
