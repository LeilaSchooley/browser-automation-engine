const PROFILE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Define an immutable workflow profile.
 *
 * Profiles contain domain policy only. Browser primitives and the generic agent
 * loop consume this descriptor without importing apply/directory modules.
 */
export function defineProfile({
  name,
  description = "",
  settings = {},
  entryLabel = "Continue",
  smartFillProfile = "all",
  intent = "complete_task",
  capabilities = [],
} = {}) {
  if (!PROFILE_NAME.test(String(name || ""))) {
    throw new TypeError("profile name must use lowercase letters, numbers, and hyphens");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new TypeError(`profile "${name}" settings must be an object`);
  }

  return Object.freeze({
    name,
    description,
    settings: Object.freeze({ ...settings }),
    entryLabel,
    smartFillProfile,
    intent,
    capabilities: Object.freeze([...new Set(capabilities)]),
  });
}

export function isProfile(value) {
  return !!(
    value &&
    typeof value === "object" &&
    PROFILE_NAME.test(String(value.name || "")) &&
    value.settings &&
    typeof value.settings === "object"
  );
}

/**
 * Extend a profile without mutating its source descriptor.
 */
export function extendProfile(base, overrides = {}) {
  if (!isProfile(base)) {
    throw new TypeError("extendProfile requires a valid base profile");
  }
  return defineProfile({
    ...base,
    ...overrides,
    name: overrides.name || base.name,
    settings: { ...base.settings, ...(overrides.settings || {}) },
    capabilities: [
      ...(base.capabilities || []),
      ...(overrides.capabilities || []),
    ],
  });
}

/**
 * Compatibility default for callers that initialize the low-level runtime
 * directly. Domain-aware createEngine() resolves named profiles before the
 * runtime is initialized.
 */
export const DEFAULT_PROFILE = defineProfile({
  name: "legacy",
  description: "Backward-compatible browser automation behavior",
  entryLabel: "Apply",
  smartFillProfile: "apply",
  intent: "submit_listing",
  capabilities: ["apply", "directory", "auth", "upload", "learning"],
});
