import {
  classifyPageUnloaded,
  classifyDeadDestination,
  classifyOauthProviderHost,
  classifyClosedJob,
  classifyAggregatorTrap,
  classifyFakeListing,
  classifyHardGate,
  classifyOauthOnlySignup,
  classifyOauthOnly,
  classifyBlockedText,
} from "./blocked.js";
import {
  classifyForceSignIn,
  classifySoftOtp,
  classifyPasswordlessLogin,
  classifyApplySignupGate,
  classifyEmailVerifyWall,
  classifyRegistrationSurface,
  classifySignupForm,
  classifyAuthForm,
} from "./authPolicy.js";
import {
  classifyJobBoardWelcome,
  classifyDidYouApply,
  classifyJobBoardIndex,
  classifyBoardSignupOnboarding,
  classifyBlockBoardSignupAfterLeave,
  classifyPlatformOnboarding,
} from "./boardAndOnboarding.js";
import {
  classifyJobAlertFirst,
  classifyPostPreferencesSignup,
  classifyBlockingOverlay,
  classifyGoogleVignette,
  classifyResumeReviewUpsell,
  classifyPreferencesGate,
  classifyResumeReviewGateAfterPrefs,
  classifyIdentityRegistration,
  classifyFilledReview,
  classifyNonCookiePopup,
  classifyMisflaggedCookie,
  classifyCookieConsent,
  classifyApplyModal,
  classifyListingEntry,
  classifyEmptyRequiredControls,
  classifyVisibleControls,
  classifyPostUploadWait,
  classifyContinue,
  classifySubmitReview,
  classifyCompetingAmbiguous,
} from "./formAndWizard.js";

/**
 * Ordered classifiers matching the original classifyApplyStep cascade.
 * Each returns a classification object or null.
 */
export const CLASSIFIERS = [
  classifyPageUnloaded,
  classifyDeadDestination,
  classifyOauthProviderHost,
  classifyClosedJob,
  classifyAggregatorTrap,
  classifyJobAlertFirst,
  classifyForceSignIn,
  classifySoftOtp,
  classifyPasswordlessLogin,
  classifyApplySignupGate,
  classifyFakeListing,
  classifyPostPreferencesSignup,
  classifyBlockingOverlay,
  classifyGoogleVignette,
  classifyJobBoardWelcome,
  classifyDidYouApply,
  classifyResumeReviewUpsell,
  classifyJobBoardIndex,
  classifyBoardSignupOnboarding,
  classifyBlockBoardSignupAfterLeave,
  classifyPlatformOnboarding,
  classifyPreferencesGate,
  classifyResumeReviewGateAfterPrefs,
  classifyHardGate,
  classifyEmailVerifyWall,
  classifyIdentityRegistration,
  classifyRegistrationSurface,
  classifySignupForm,
  classifyAuthForm,
  classifyOauthOnlySignup,
  classifyOauthOnly,
  classifyBlockedText,
  classifyFilledReview,
  classifyNonCookiePopup,
  classifyMisflaggedCookie,
  classifyCookieConsent,
  classifyApplyModal,
  classifyListingEntry,
  classifyEmptyRequiredControls,
  classifyVisibleControls,
  classifyPostUploadWait,
  classifyContinue,
  classifySubmitReview,
  classifyCompetingAmbiguous,
];

/** Return the first non-null classification from CLASSIFIERS. */
export function runClassifiers(ctx) {
  for (const classify of CLASSIFIERS) {
    const result = classify(ctx);
    if (result) return result;
  }
  return null;
}
