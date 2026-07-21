import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectOtpFromSnap, countOtpDigitFields } from "../src/patterns/otpDetect.js";
import { classifyPageRoleFromSnap } from "../src/layers/classifyPageRole.js";
import { looksLikeOtpWall } from "../src/inboxOtp.js";

describe("OTP page role", () => {
  const dribbblePasscodeSnap = {
    title: "Ecommerce Conversion Designer at Kontinuum Marketing - - Dribbble Design Jobs",
    pageText: "Apply for this position Mobile Print Animation Branding",
    headings: "",
    fieldCount: 6,
    entryCount: 2,
    fields: [
      { type: "text", label: "Code digit 1 of 6" },
      { type: "text", label: "Code digit 2 of 6" },
      { type: "text", label: "Code digit 3 of 6" },
      { type: "text", label: "Code digit 4 of 6" },
      { type: "text", label: "Code digit 5 of 6" },
      { type: "text", label: "Code digit 6 of 6" },
    ],
  };

  it("detects Dribbble 6-digit boxes without passcode body text", () => {
    assert.equal(countOtpDigitFields(dribbblePasscodeSnap), 6);
    const d = detectOtpFromSnap(dribbblePasscodeSnap);
    assert.equal(d.isOtp, true);
    assert.match(d.reason, /otp_digit_boxes/);
    assert.equal(looksLikeOtpWall(dribbblePasscodeSnap), true);
  });

  it("classifies as otp role — not job_application", () => {
    const role = classifyPageRoleFromSnap(dribbblePasscodeSnap);
    assert.equal(role.role, "otp");
  });

  it("detects passcode body + single code field", () => {
    const snap = {
      title: "Create your account",
      pageText: "We've sent you a passcode. Please check your inbox. Resend code",
      headings: "Create your account",
      fieldCount: 1,
      fields: [{ type: "text", label: "Verification code", autocomplete: "one-time-code" }],
    };
    assert.equal(detectOtpFromSnap(snap).isOtp, true);
    assert.equal(classifyPageRoleFromSnap(snap).role, "otp");
  });

  it("does not treat Greenhouse apply form as otp", () => {
    const snap = {
      title: "Apply — Acme",
      pageText: "Submit application Cover letter EEOC",
      fieldCount: 8,
      fields: [
        { type: "text", label: "Full name" },
        { type: "email", label: "Email" },
        { type: "tel", label: "Phone" },
      ],
      fileInputCount: 1,
    };
    assert.equal(detectOtpFromSnap(snap).isOtp, false);
    assert.notEqual(classifyPageRoleFromSnap(snap).role, "otp");
  });
});
