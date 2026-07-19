/**
 * Minimal TOTP (RFC 6238) for site-account authenticator secrets.
 * Enabled only when settings.totp_enabled is true.
 */
import crypto from "crypto";
import { getSettings } from "./runtime.js";

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = String(input || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of cleaned) {
    const val = alphabet.indexOf(c);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generate a 6-digit TOTP code from a base32 secret.
 */
export function generateTotpCode(secret, { period = 30, digits = 6, now = Date.now() } = {}) {
  if (!secret) return "";
  const key = base32Decode(secret);
  if (!key.length) return "";
  const counter = Math.floor(now / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

/**
 * Resolve TOTP from context/site account when enabled.
 */
export function resolveTotpCode(context, hostname = "") {
  const settings = getSettings();
  if (settings.totp_enabled !== true) return "";
  const auth = context?.auth || {};
  const account = context?.siteAccount || {};
  const secret = auth.totpSecret || account.totpSecret || account.totp_secret || "";
  if (!secret) return "";
  return generateTotpCode(secret);
}
