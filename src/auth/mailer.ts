/**
 * Outbound mail for account recovery.
 * - Production: real SMTP via nodemailer (SMTP_HOST + MAIL_FROM required)
 * - Local/test without SMTP: file sink under data/mail-outbox (never logs secrets)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type MailDeliveryMode = "smtp" | "local_file" | "memory";

export type MailSendResult = {
  ok: boolean;
  transport: MailDeliveryMode;
  error?: string;
};

type MailerGlobal = typeof globalThis & {
  __miraeMailOutbox?: MailMessage[];
};

type EnvMap = Record<string, string | undefined>;

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

export function mailTransportConfigured(env: EnvMap = process.env): "smtp" | "file" {
  if (env.SMTP_HOST?.trim() && env.MAIL_FROM?.trim()) return "smtp";
  return "file";
}

/** Public, non-secret delivery mode for UI (does not reveal whether a user exists). */
export function publicMailDeliveryMode(env: EnvMap = process.env): "smtp" | "local_file" {
  return mailTransportConfigured(env) === "smtp" ? "smtp" : "local_file";
}

function writeFileSink(message: MailMessage, to: string, prefix = ""): void {
  const dir = path.join(process.cwd(), "data", "mail-outbox");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTo = to.replace(/[^a-z0-9@._-]/gi, "_");
  const file = path.join(dir, `${prefix}${stamp}-${safeTo}.txt`);
  appendFileSync(file, `To: ${to}\nSubject: ${message.subject}\n\n${message.text}\n`, "utf8");
}

async function sendViaSmtp(
  message: MailMessage,
  to: string,
  env: EnvMap,
): Promise<MailSendResult> {
  const host = env.SMTP_HOST!.trim();
  const from = env.MAIL_FROM!.trim();
  const port = Number(env.SMTP_PORT?.trim() || "587");
  const secure =
    String(env.SMTP_SECURE ?? "").toLowerCase() === "true" || port === 465;
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS ?? "";

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });

  try {
    await transporter.sendMail({
      from,
      to,
      subject: message.subject,
      text: message.text,
    });
    return { ok: true, transport: "smtp" };
  } catch {
    // Never log SMTP credentials, tokens, or full message bodies.
    // Keep a local copy for operators; client still gets a uniform recovery message.
    try {
      writeFileSink(message, to, "smtp-failed-");
    } catch {
      /* ignore secondary failure */
    }
    return { ok: false, transport: "smtp", error: "smtp_send_failed" };
  } finally {
    transporter.close();
  }
}

export async function sendMail(
  message: MailMessage,
  env: EnvMap = process.env,
): Promise<MailSendResult> {
  const to = message.to.trim().toLowerCase();
  if (!to.includes("@")) return { ok: false, transport: "local_file", error: "invalid recipient" };

  // Always keep an in-memory copy for local verification (tests).
  outbox().push({ to, subject: message.subject, text: message.text });
  if (outbox().length > 200) outbox().shift();

  // Unit/integration tests force the file/memory sink.
  if (env.MIRAEMAESU_TEST === "1") {
    try {
      writeFileSink(message, to);
      return { ok: true, transport: "memory" };
    } catch (err) {
      return {
        ok: false,
        transport: "memory",
        error: err instanceof Error ? err.message : "mail file sink failed",
      };
    }
  }

  if (mailTransportConfigured(env) === "smtp") {
    return sendViaSmtp(message, to, env);
  }

  try {
    writeFileSink(message, to);
    return { ok: true, transport: "local_file" };
  } catch (err) {
    return {
      ok: false,
      transport: "local_file",
      error: err instanceof Error ? err.message : "mail file sink failed",
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
