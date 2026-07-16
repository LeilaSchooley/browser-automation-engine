/**
 * Resolve applicant identity for fills — never invent names/emails.
 * Apps put real values on context.applicant (or context.profile).
 */

export function getApplicantProfile(context = {}) {
  const a = context.applicant || context.profile || {};
  const fullName = String(a.fullName || a.name || a.founderName || "").trim();
  let firstName = String(a.firstName || "").trim();
  let lastName = String(a.lastName || "").trim();
  if ((!firstName || !lastName) && fullName) {
    const parts = fullName.split(/\s+/);
    firstName = firstName || parts[0] || "";
    lastName = lastName || parts.slice(1).join(" ") || "";
  }
  return {
    firstName,
    lastName,
    fullName: fullName || [firstName, lastName].filter(Boolean).join(" "),
    email: String(a.email || "").trim(),
    phone: String(a.phone || "").trim(),
    linkedinUrl: String(a.linkedinUrl || a.linkedin || "").trim(),
    websiteUrl: String(a.websiteUrl || a.website || "").trim(),
    city: String(a.city || "").trim(),
    state: String(a.state || "").trim(),
    country: String(a.country || "").trim(),
    addressLine1: String(a.addressLine1 || "").trim(),
    addressLine2: String(a.addressLine2 || "").trim(),
    postalCode: String(a.postalCode || a.postalCode || a.zip || "").trim(),
    pronouns: String(a.pronouns || "").trim(),
  };
}

export function applicantPromptBlock(context) {
  const p = getApplicantProfile(context);
  if (!p.fullName && !p.email) {
    return "APPLICANT PROFILE: (not provided — do not invent identity; prefer wait_user for registration gates)";
  }
  return `APPLICANT PROFILE (use ONLY these values — never invent names, emails, phones, or addresses):
- Full name: ${p.fullName || "(none)"}
- First name: ${p.firstName || "(none)"}
- Last name: ${p.lastName || "(none)"}
- Email: ${p.email || "(none)"}
- Phone: ${p.phone || "(none)"}
- LinkedIn: ${p.linkedinUrl || "(none)"}
- Website: ${p.websiteUrl || "(none)"}
- City: ${p.city || "(none)"}
- State: ${p.state || "(none)"}
- Postal code: ${p.postalCode || "(none)"}
- Country: ${p.country || "(none)"}
- Address: ${p.addressLine1 || "(none)"}`;
}

/** Map a field label/target to a profile value. */
export function resolveIdentityFillValue(targetHint, proposedValue, context) {
  const p = getApplicantProfile(context);
  const blob = String(targetHint || "").toLowerCase();
  if (/first\s*name|given\s*name|forename|fname/i.test(blob)) return p.firstName || proposedValue;
  if (/last\s*name|surname|family\s*name|lname/i.test(blob)) return p.lastName || proposedValue;
  if (/full\s*name|your\s*name|chosen\s*name|preferred\s*name|^name$/i.test(blob) && !/user\s*name|company/i.test(blob)) {
    return p.fullName || proposedValue;
  }
  if (/\bemail\b|e-mail/i.test(blob)) return p.email || proposedValue;
  if (/\bphone\b|mobile|tel\b/i.test(blob)) return p.phone || proposedValue;
  if (/linkedin/i.test(blob)) return p.linkedinUrl || proposedValue;
  if (/website|portfolio|url/i.test(blob) && !/linkedin/i.test(blob)) return p.websiteUrl || proposedValue;
  if (/\bcity\b|town/i.test(blob) && !/state|zip|postal/i.test(blob)) return p.city || proposedValue;
  if (/\bstate\b|province/i.test(blob) && !/city|zip|postal/i.test(blob)) return p.state || proposedValue;
  if (/\bcountry\b/i.test(blob)) return p.country || proposedValue;
  if (/postal|zip\s*code|\bzip\b|postcode/i.test(blob)) return p.postalCode || "";
  if (/city,\s*state|city\/state|\bzip code\b/i.test(blob)) {
    return [p.city, p.state, p.postalCode].filter(Boolean).join(", ") || "";
  }
  if (/address|street/i.test(blob)) {
    // Never fall back to email / phone-looking proposed values when street is empty.
    if (p.addressLine1) return p.addressLine1;
    if (/@|\.com\b/i.test(String(proposedValue || ""))) return "";
    return "";
  }
  if (/\bpronouns?\b/i.test(blob)) return p.pronouns || proposedValue;
  return proposedValue;
}

/** True when snap looks like create-account with personal name fields. */
export function hasIdentityRegistrationFields(snap) {
  const labels = (snap?.fields || []).map((f) => `${f.label || ""} ${f.name || ""}`.toLowerCase());
  const hasFirst = labels.some((l) => /first\s*name|given\s*name/.test(l));
  const hasLast = labels.some((l) => /last\s*name|surname|family/.test(l));
  const hasEmail = (snap?.emailFieldCount || 0) > 0 || labels.some((l) => /\bemail\b/.test(l));
  const hasPassword = (snap?.passwordFieldCount || 0) > 0;
  return (hasFirst || hasLast) && hasEmail && (hasPassword || (snap?.fieldCount || 0) >= 3);
}
