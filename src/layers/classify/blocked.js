import { isPageUnloaded } from "../pageReady.js";
import {
  looksLikeDeadApplyDestination,
  looksLikeAggregatorTrap,
  isOauthProviderHost,
} from "../applyUrlSafety.js";
import {
  looksLikeOAuthOnly,
  looksLikeHardGate,
} from "../authActions.js";
import { looksLikeOAuthOnlySignup } from "../signupActions.js";
import { canProvisionAccounts } from "../../accountStore.js";
import {
  looksLikeFakeJobListing,
  looksLikeClosedJobListing,
} from "../../heuristics.js";
import { BLOCKED_TEXT } from "../../patterns/index.js";

export function classifyPageUnloaded(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!isPageUnloaded(snap)) return null;
  return {
    step: "loading",
    confidence: "high",
    reason: "page still loading — no affordances yet",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyDeadDestination(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  const dead = looksLikeDeadApplyDestination(snap);
  if (!dead.dead) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: dead.reason,
    target: null,
    affordances,
    fingerprint: fp,
    hardStop: true,
  };
}

export function classifyOauthProviderHost(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!isOauthProviderHost(snap.url || snap.hostname || "")) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: "third-party SSO (Apple/Google/…) — use email Continue on the job site",
    target: null,
    affordances,
    fingerprint: fp,
    hardStop: true,
  };
}

export function classifyClosedJob(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  const closedJob = looksLikeClosedJobListing(snap);
  if (!closedJob.closed) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: closedJob.reason,
    target: null,
    affordances,
    fingerprint: fp,
    hardStop: true,
  };
}

export function classifyAggregatorTrap(ctx) {
  const { snap, history, affordances, fingerprint: fp } = ctx;
  const trap = looksLikeAggregatorTrap(snap, history);
  if (!trap.trapped) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: trap.reason,
    target: null,
    affordances,
    fingerprint: fp,
    hardStop: true,
  };
}

export function classifyFakeListing(ctx) {
  const { snap, history, affordances, fingerprint: fp } = ctx;
  const fakeListing = looksLikeFakeJobListing(snap, history);
  if (!fakeListing.fake) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: fakeListing.reason,
    target: null,
    affordances,
    fingerprint: fp,
    hardStop: true,
  };
}

export function classifyHardGate(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  const hard = looksLikeHardGate(snap);
  if (!hard.hard) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: hard.reason,
    target: null,
    affordances,
    fingerprint: fp,
    hardStop: true,
  };
}

export function classifyOauthOnlySignup(ctx) {
  const { snap, filled, context, affordances, fingerprint: fp } = ctx;
  if (!(looksLikeOAuthOnlySignup(snap) && filled === 0 && !canProvisionAccounts(context))) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: "OAuth-only signup — email registration not available on this page",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyOauthOnly(ctx) {
  const { snap, filled, affordances, fingerprint: fp } = ctx;
  if (!(looksLikeOAuthOnly(snap) && filled === 0)) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: "OAuth-only sign-in (Google/X/GitHub) — manual login required",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyBlockedText(ctx) {
  const { snap, filled, affordances, fingerprint: fp } = ctx;
  const blockedBlob = `${snap?.title || ""} ${snap?.applyModalTitle || ""} ${snap?.url || ""}`.toLowerCase();
  if (!(BLOCKED_TEXT.test(blockedBlob) && (snap?.fieldCount || 0) < 2 && filled === 0)) return null;
  return {
    step: "blocked",
    confidence: "high",
    reason: "login, captcha, or payment wall detected",
    target: null,
    affordances,
    fingerprint: fp,
  };
}
