/**
 * Email verification poller — IMAP when configured, manual GUI link otherwise.
 */
import { getSettings } from "./runtime.js";
import {
  isImapConfigured,
  normalizeVerifyLink,
  waitForManualVerifyLink,
} from "./manualVerifyLink.js";

const VERIFY_LINK =
  /https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|validation|token)[^\s"'<>]*/gi;

export function looksLikeEmailVerifyWall(snap) {
  const modalText = (snap?.modalCandidates || []).map((c) => c.text || "").join(" ");
  const continueText = (snap?.continueCandidates || []).map((c) => c.text || "").join(" ");
  const blob = `${snap?.title || ""} ${snap?.pageText || ""} ${snap?.headings || ""} ${modalText} ${continueText}`.toLowerCase();
  return /\b(check your (email|inbox)|verify your email|activate your account|confirmation (email|link)|we sent you|confirm your account)\b/i.test(
    blob,
  );
}

/**
 * Optional IMAP fetch. Requires EMAIL_IMAP_USER / EMAIL_IMAP_PASS / EMAIL_IMAP_HOST.
 * Returns first verify URL matching host filter, or null.
 */
export async function pollVerifyLink({ hostFilter = "", timeoutMs = 20000 } = {}) {
  const settings = getSettings();
  if (settings.email_verify_enabled === false) return null;

  const user = process.env.EMAIL_IMAP_USER || settings.email_imap_user || "";
  const pass = process.env.EMAIL_IMAP_PASS || settings.email_imap_pass || "";
  const host = process.env.EMAIL_IMAP_HOST || settings.email_imap_host || "";
  if (!user || !pass || !host) return null;

  // Dynamic import so engine works without imapflow installed
  let ImapFlow;
  try {
    ({ ImapFlow } = await import("imapflow"));
  } catch {
    return null;
  }

  const client = new ImapFlow({
    host,
    port: Number(process.env.EMAIL_IMAP_PORT || settings.email_imap_port || 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const deadline = Date.now() + timeoutMs;
  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const since = new Date(Date.now() - 15 * 60 * 1000);
        for await (const msg of client.fetch({ since }, { source: true, envelope: true })) {
          const raw = msg.source?.toString?.() || "";
          const links = raw.match(VERIFY_LINK) || [];
          for (const link of links) {
            const clean = normalizeVerifyLink(link);
            if (!hostFilter || clean.includes(hostFilter.replace(/^www\./, ""))) {
              return clean;
            }
          }
        }
      } finally {
        lock.release();
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch {
    return null;
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function attemptEmailVerify(page, snap, log, { sessionId = null } = {}) {
  if (!looksLikeEmailVerifyWall(snap)) return false;
  log?.layer("inbox", "email verify wall — polling inbox", "info");
  const host = (snap.hostname || "").replace(/^www\./, "");
  const settings = getSettings();
  const imapTimeout = settings.email_verify_timeout_ms || 25000;
  let link = await pollVerifyLink({ hostFilter: host, timeoutMs: imapTimeout });
  const imapConfigured = isImapConfigured();
  const imapFailed = imapConfigured && !link;

  if (!link && sessionId != null) {
    const manualTimeout = settings.email_verify_manual_timeout_ms || 600_000;
    const message = imapFailed
      ? "Couldn't find the verification email via IMAP — paste the confirmation link below."
      : imapConfigured
        ? "Waiting for verification email — paste the confirmation link if it doesn't arrive automatically."
        : "Email verification required — paste the confirmation link from your inbox below.";
    log?.layer(
      "inbox",
      imapConfigured
        ? "IMAP found no link — waiting for manual verification URL in dashboard"
        : "no IMAP configured — waiting for manual verification URL in dashboard",
      "info",
    );
    try {
      link = await waitForManualVerifyLink(sessionId, {
        timeoutMs: manualTimeout,
        message,
        imapFailed,
      });
    } catch (err) {
      log?.layer("inbox", `manual verify link not provided (${err.message})`, "warn");
      return false;
    }
  }

  if (!link) {
    log?.layer(
      "inbox",
      "no verify link found (configure EMAIL_IMAP_* in Settings or paste link in dashboard)",
      "warn",
    );
    return false;
  }

  log?.layer("inbox", `opening verify link ${link.slice(0, 80)}`, "info");
  await page.goto(link, { waitUntil: "domcontentloaded", timeout: 20000 });
  return true;
}
