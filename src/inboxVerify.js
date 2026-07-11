/**
 * Email verification poller — IMAP when configured, otherwise no-op.
 */
import { getSettings } from "./runtime.js";

const VERIFY_LINK =
  /https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|validation|token)[^\s"'<>]*/gi;

export function looksLikeEmailVerifyWall(snap) {
  const blob = `${snap?.title || ""} ${snap?.pageText || ""} ${snap?.headings || ""}`.toLowerCase();
  return /\b(check your (email|inbox)|verify your email|confirmation (email|link)|we sent you|confirm your account)\b/i.test(
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
    port: Number(process.env.EMAIL_IMAP_PORT || 993),
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
            const clean = link.replace(/[>)\]"']+$/, "");
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

export async function attemptEmailVerify(page, snap, log) {
  if (!looksLikeEmailVerifyWall(snap)) return false;
  log?.layer("inbox", "email verify wall — polling inbox", "info");
  const host = (snap.hostname || "").replace(/^www\./, "");
  const link = await pollVerifyLink({ hostFilter: host, timeoutMs: getSettings().email_verify_timeout_ms || 25000 });
  if (!link) {
    log?.layer("inbox", "no verify link found (configure EMAIL_IMAP_* or wait for review)", "warn");
    return false;
  }
  log?.layer("inbox", `opening verify link ${link.slice(0, 80)}`, "info");
  await page.goto(link, { waitUntil: "domcontentloaded", timeout: 20000 });
  return true;
}
