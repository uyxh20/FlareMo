import { FORK_PRODUCT_NAME } from "@flaremo/contracts";
import {
  type EmailLocale,
  emailCopy,
  interpolate,
  isRtlEmailLocale,
  pickEmailLocale,
} from "./email-templates";
import type { FlareMoEnv } from "./env";
import { resolveEmailIntegration } from "./integrations/config";

type SendDb = Parameters<typeof resolveEmailIntegration>[1];

/**
 * Pluggable transactional email for registration verification.
 *
 * - `none` (default): self-hosted zero-config; registration does not require
 *   email verification.
 * - `cloudflare`: Cloudflare Email Sending (Workers Paid plan) via the
 *   `EMAIL` binding (`env.EMAIL.send({to, from, subject, html, text})`).
 *   The sender address must be a verified domain in the account.
 * - `resend`: the Resend HTTP API through `fetch` (no SMTP, so it runs on
 *   Workers). Configurable from the admin email settings (owner-only) or via
 *   `FLAREMO_EMAIL_PROVIDER=resend` + `RESEND_API_KEY` env vars; the admin
 *   (D1) configuration wins when the env path is not fully configured.
 *
 * The seam mirrors the embedding/captcha provider pattern: the kernel never
 * hardcodes a vendor, and a deployment that does not configure a provider
 * keeps the exact self-hosted behavior.
 */

export type EmailProvider = "none" | "cloudflare" | "resend";

export type EmailSendConfig = {
  provider: EmailProvider;
  /** Verified sender address, e.g. "no-reply@flaremo.app". */
  from: string | null;
  /** Resend API key; only populated for the resend provider. */
  resendApiKey: string | null;
};

/**
 * Effective email configuration: environment variables win when they fully
 * configure a provider, else the owner's encrypted D1 settings (admin email
 * settings) apply.
 */
export async function resolveEmailSendConfig(
  env: FlareMoEnv,
  db: Parameters<typeof resolveEmailIntegration>[1],
): Promise<EmailSendConfig> {
  const resolved = await resolveEmailIntegration(env, db);
  return {
    provider: resolved.provider,
    from: resolved.from,
    resendApiKey: resolved.resendApiKey,
  };
}

export type SendVerificationEmailInput = {
  to: string;
  /** Single-use verification token (already minted). */
  token: string;
  /** Public origin of the deployment, e.g. https://app.flaremo.app. */
  publicUrl: string;
  /**
   * Raw Accept-Language header of the request that triggered the send.
   * Every send path is self-service, so the requester is the recipient.
   */
  acceptLanguage?: string | null;
};

type DeliverEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

function logEmailFailure(to: string, error: unknown) {
  // Callers degrade to a generic "email unavailable" response; the server
  // log is the only place the actual delivery failure is visible.
  console.error(
    JSON.stringify({
      level: "error",
      message: "Email delivery failed",
      to,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function deliverEmail(
  env: FlareMoEnv,
  db: NonNullable<Parameters<typeof resolveEmailIntegration>[1]>,
  input: DeliverEmailInput,
): Promise<boolean> {
  const config = await resolveEmailSendConfig(env, db);
  if (config.provider === "none" || !config.from) return false;

  try {
    if (config.provider === "cloudflare") {
      const binding = (
        env as FlareMoEnv & {
          EMAIL?: { send: (msg: unknown) => Promise<unknown> };
        }
      ).EMAIL;
      if (!binding) return false;
      await binding.send({
        to: input.to,
        from: config.from,
        subject: input.subject,
        html: input.html,
        text: input.text,
      });
      return true;
    }
    // resend
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.resendApiKey ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Resend API returned ${response.status}`);
    }
    return true;
  } catch (error) {
    logEmailFailure(input.to, error);
    return false;
  }
}

function actionButtonHtml(url: string, label: string) {
  return `<p><a href="${url}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px">${label}</a></p>`;
}

function footerHtml(
  copy: ReturnType<typeof emailCopy>,
  url: string,
  expiryHours: number,
  ignoreNote: string,
) {
  return [
    `<p style="color:#888;font-size:12px">${interpolate(copy.pasteLink, { url })}</p>`,
    `<p style="color:#888;font-size:12px">${interpolate(copy.expiresHours, { hours: expiryHours })} ${ignoreNote}</p>`,
  ].join("");
}

function emailHtml(
  locale: EmailLocale,
  heading: string,
  body: string,
  actionHtml: string,
  footer: string,
) {
  // lang rides along with dir: it selects the Han face a client picks for CJK
  // mail (Japanese recipients otherwise get Chinese glyph forms) and lets a
  // screen reader pronounce the message in the right language.
  const rtl = isRtlEmailLocale(locale);
  const dir = rtl ? "rtl" : "ltr";
  const align = rtl ? ";text-align:right" : "";
  return `<div lang="${locale}" dir="${dir}" style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px${align}"><h2 style="margin:0 0 12px">${heading}</h2><p style="color:#444;line-height:1.6">${body}</p>${actionHtml}${footer}</div>`;
}
/**
 * Send the registration verification email.
 */
export async function sendVerificationEmail(
  env: FlareMoEnv,
  db: SendDb,
  input: SendVerificationEmailInput,
): Promise<boolean> {
  const copy = emailCopy(pickEmailLocale(input.acceptLanguage));
  const verifyUrl = `${input.publicUrl.replace(/\/+$/, "")}/verify-email?token=${encodeURIComponent(input.token)}`;
  return deliverEmail(env, db, {
    to: input.to,
    subject: copy.verifyEmail.subject,
    html: [
      emailHtml(
        pickEmailLocale(input.acceptLanguage),
        copy.verifyEmail.heading,
        copy.verifyEmail.body,
        actionButtonHtml(verifyUrl, copy.verifyEmail.button),
        footerHtml(copy, verifyUrl, 24, copy.verifyEmail.ignore),
      ),
    ].join(""),
    text: `${copy.verifyEmail.body}\n\n${verifyUrl}\n\n${interpolate(copy.expiresHours, { hours: 24 })} ${copy.verifyEmail.ignore}`,
  });
}

/**
 * Send the self-service password reset email. The link opens the existing
 * /reset page, which submits the token to Better Auth's reset-password
 * endpoint; the recipient always sets their own new password.
 */
export async function sendPasswordResetEmail(
  env: FlareMoEnv,
  db: SendDb,
  input: SendVerificationEmailInput,
): Promise<boolean> {
  const locale = pickEmailLocale(input.acceptLanguage);
  const copy = emailCopy(locale);
  const resetUrl = `${input.publicUrl.replace(/\/+$/, "")}/reset?token=${encodeURIComponent(input.token)}`;
  return deliverEmail(env, db, {
    to: input.to,
    subject: copy.resetPassword.subject,
    html: [
      emailHtml(
        locale,
        copy.resetPassword.heading,
        copy.resetPassword.body,
        actionButtonHtml(resetUrl, copy.resetPassword.button),
        footerHtml(copy, resetUrl, 1, copy.resetPassword.ignore),
      ),
    ].join(""),
    text: `${copy.resetPassword.body}\n\n${resetUrl}\n\n${interpolate(copy.expiresHours, { hours: 1 })} ${copy.resetPassword.ignore}`,
  });
}

/**
 * Send the "verify your new email address" mail for an email change. The
 * change only takes effect after the recipient confirms ownership of the new
 * address through this link.
 */
export async function sendEmailChangeVerificationEmail(
  env: FlareMoEnv,
  db: SendDb,
  input: SendVerificationEmailInput,
): Promise<boolean> {
  const locale = pickEmailLocale(input.acceptLanguage);
  const copy = emailCopy(locale);
  const verifyUrl = `${input.publicUrl.replace(/\/+$/, "")}/verify-email-change?token=${encodeURIComponent(input.token)}`;
  return deliverEmail(env, db, {
    to: input.to,
    subject: copy.changeEmail.subject,
    html: [
      emailHtml(
        locale,
        copy.changeEmail.heading,
        copy.changeEmail.body,
        actionButtonHtml(verifyUrl, copy.changeEmail.button),
        footerHtml(copy, verifyUrl, 24, copy.changeEmail.ignore),
      ),
    ].join(""),
    text: `${copy.changeEmail.body}\n\n${verifyUrl}\n\n${interpolate(copy.expiresHours, { hours: 24 })} ${copy.changeEmail.ignore}`,
  });
}

/**
 * Send a plain "configuration works" email from the admin email settings
 * test button. Delivered through the effective configuration so the test
 * exercises the same path real mail will take.
 */
export async function sendTestEmail(
  env: FlareMoEnv,
  db: SendDb,
  config: EmailSendConfig,
  to: string,
): Promise<boolean> {
  if (config.provider === "none" || !config.from) return false;
  return deliverEmail(env, db, {
    to,
    subject: `${FORK_PRODUCT_NAME} — 邮件配置测试成功 / test email`,
    html: emailHtml(
      "zh-CN",
      "邮件配置测试成功",
      "这封邮件确认当前实例的交易邮件配置可用。",
      "",
      "",
    ),
    text: `${FORK_PRODUCT_NAME} 邮件配置测试成功 / ${FORK_PRODUCT_NAME} test email: your email configuration works.`,
  });
}
