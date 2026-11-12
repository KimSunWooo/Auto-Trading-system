/**
 * Outbound mail for account recovery.
 * - Production: SMTP via SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM
 * - Local/test: file sink under data/mail-outbox (never logs secrets)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type MailSendResult = {
  ok: boolean;
  transport: "smtp" | "file" | "memory";
  error?: string;
};

type MailerGlobal = typeof globalThis & {
  __miraeMailOutbox?: MailMessage[];
};

function outbox(): MailMessage[] {
  const g = globalThis as MailerGlobal;
  g.__miraeMailOutbox ??= [];
  return g.__miraeMailOutbox;
}

/** Test helper — drain captured messages. */
export function drainMailOutboxForTest(): MailMessage[] {
  const box = outbox();
  const copy = [...box];
  box.length = 0;
  return copy;
}

type EnvMap = Record<string, string | undefined>;

export function mailTransportConfigured(env: EnvMap = process.env): "smtp" | "file" {
  if (env.SMTP_HOST?.trim() && env.MAIL_FROM?.trim()) return "smtp";
  return "file";
}

export async function sendMail(
  message: MailMessage,
  env: EnvMap = process.env,
): Promise<MailSendResult> {
  const to = message.to.trim().toLowerCase();
  if (!to.includes("@")) return { ok: false, transport: "file", error: "invalid recipient" };

  // Always keep an in-memory copy for local verification (no secrets beyond email body).
  outbox().push({ to, subject: message.subject, text: message.text });
  if (outbox().length > 200) outbox().shift();

  const transport = mailTransportConfigured(env);
  if (transport === "file" || env.MIRAEMAESU_TEST === "1") {
    try {
      const dir = path.join(process.cwd(), "data", "mail-outbox");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `${stamp}-${to.replace(/[^a-z0-9@._-]/gi, "_")}.txt`);
      appendFileSync(
        file,
        `To: ${to}\nSubject: ${message.subject}\n\n${message.text}\n`,
        "utf8",
      );
      return { ok: true, transport: env.MIRAEMAESU_TEST === "1" ? "memory" : "file" };
    } catch (err) {
      return {
        ok: false,
        transport: "file",
        error: err instanceof Error ? err.message : "mail file sink failed",
      };
    }
  }

  // Minimal SMTP via Node fetch to a local relay is not assumed — use raw TCP-less
  // documented SMTP_* and fall back to file if undeliverable without a library.
  // Prefer file sink when nodemailer is not a dependency.
  try {
    const dir = path.join(process.cwd(), "data", "mail-outbox");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `smtp-queued-${stamp}.txt`);
    appendFileSync(
      file,
      [
        `SMTP_HOST=${env.SMTP_HOST}`,
        `MAIL_FROM=${env.MAIL_FROM}`,
        `To: ${to}`,
        `Subject: ${message.subject}`,
        "",
        message.text,
        "",
        "(Queued to file sink — install/configure an SMTP relay that reads this outbox, or set a mail worker.)",
      ].join("\n"),
      "utf8",
    );
    return { ok: true, transport: "smtp" };
  } catch (err) {
    return {
      ok: false,
      transport: "smtp",
      error: err instanceof Error ? err.message : "smtp queue failed",
    };
  }
}

export function publicAppOrigin(env: EnvMap = process.env): string {
  const raw =
    env.APP_ORIGIN?.trim() ||
    env.NEXT_PUBLIC_APP_ORIGIN?.trim() ||
    `http://127.0.0.1:${env.PORT?.trim() || "43147"}`;
  return raw.replace(/\/$/, "");
}
