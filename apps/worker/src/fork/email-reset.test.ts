import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SendVerificationEmailInput,
  sendPasswordResetEmail,
} from "../email";
import { emailCopy } from "../email-templates";
import { createFlareMoApp } from "../index";
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime, TEST_PASSWORD } from "../test-support/runtime";

// Fork-owned checks on the self-service password reset (docs/fork-customizations.md).
// They used to sit inside upstream's registration-email.test.ts and
// email-templates.test.ts, where every upstream edit near them made a merge
// conflict. The fork changes nothing in the reset itself: it runs through
// upstream's POST /api/auth/flaremo/forgot-password. Better Auth's own
// /api/auth/request-password-reset stays off, as upstream ships it.

let mf: Miniflare;
let env: Env;
let sessionCookie: string;

const { extractCookieHeader, bootstrapAndSignIn } = createAppTestHarness(
  () => ({ env, sessionCookie }),
);

describe("fork: self-service password reset", () => {
  beforeEach(async () => {
    ({ runtime: mf, env } = await createTestRuntime({
      databaseName: "flaremo-fork-reset-test",
      attachmentsName: "flaremo-fork-reset-attachments-test",
      env: { FLAREMO_DEPLOY_REPOSITORY: "example/flaremo" },
    }));
    sessionCookie = await bootstrapAndSignIn();
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("revokes browser sessions on self-service reset but leaves memos_pat_ tokens enabled", async () => {
    const emailApp = createFlareMoApp();
    const open = await emailApp.fetch(
      new Request("http://flaremo.test/api/app/admin/settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({ registration_open: true }),
      }),
      env,
    );
    expect(open.status).toBe(200);

    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const appEnv = {
      ...env,
      FLAREMO_EMAIL_PROVIDER: "cloudflare",
      FLAREMO_EMAIL_FROM: "no-reply@flaremo.test",
      EMAIL: {
        send: async (msg: { to: string; subject: string; text: string }) => {
          sent.push(msg);
          return { ok: true };
        },
      },
    } as Env;

    const register = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          name: "Pat Member",
          email: "pat-reset@example.com",
          password: TEST_PASSWORD,
        }),
      }),
      appEnv,
    );
    expect(register.status).toBe(201);

    const signIn = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          email: "pat-reset@example.com",
          password: TEST_PASSWORD,
        }),
      }),
      appEnv,
    );
    expect(signIn.status).toBe(200);
    const cookie = extractCookieHeader(signIn);

    const createdPat = await emailApp.fetch(
      new Request(
        "http://flaremo.test/api/app/account/personal-access-tokens",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            origin: "http://flaremo.test",
          },
          body: JSON.stringify({ name: "reset-survival", expires_in_days: 30 }),
        },
      ),
      appEnv,
    );
    expect(createdPat.status).toBe(201);
    const pat = (await createdPat.json()) as { token: string };
    expect(pat.token).toMatch(/^memos_pat_/);

    const forgot = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/forgot-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({ email: "pat-reset@example.com" }),
      }),
      appEnv,
    );
    expect(forgot.status).toBe(200);
    const resetToken = /reset\?token=([A-Za-z0-9-]+)/.exec(
      sent.at(-1)?.text ?? "",
    )?.[1];
    expect(resetToken).toBeDefined();

    const reset = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/reset-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          newPassword: `${TEST_PASSWORD}-rotated`,
          token: resetToken,
        }),
      }),
      appEnv,
    );
    expect(reset.status).toBe(200);

    const staleSessionWithCookie = await emailApp.fetch(
      new Request("http://flaremo.test/api/app/memos", {
        headers: { cookie },
      }),
      appEnv,
    );
    expect(staleSessionWithCookie.status).toBe(401);

    const livePat = await emailApp.fetch(
      new Request("http://flaremo.test/api/v1/memos", {
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      appEnv,
    );
    expect(livePat.status).toBe(200);
  });

  it("keeps Better Auth's native reset endpoint off, so it sends no mail", async () => {
    const sent: Array<{ to: string }> = [];
    const appEnv = {
      ...env,
      FLAREMO_EMAIL_PROVIDER: "cloudflare",
      FLAREMO_EMAIL_FROM: "no-reply@flaremo.test",
      EMAIL: {
        send: async (msg: { to: string }) => {
          sent.push(msg);
          return { ok: true };
        },
      },
    } as Env;
    const response = await createFlareMoApp().fetch(
      new Request("http://flaremo.test/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({ email: "owner@example.com" }),
      }),
      appEnv,
    );
    expect(response.status).not.toBe(200);
    expect(sent).toHaveLength(0);
  });
});

describe("fork: reset mail through Resend", () => {
  const baseInput = (
    acceptLanguage: string | null,
  ): SendVerificationEmailInput => ({
    to: "user@example.com",
    token: "tok",
    publicUrl: "https://app.example.com",
    acceptLanguage,
  });

  it("posts reset mail to Resend when FLAREMO_EMAIL_PROVIDER is resend", async () => {
    const captured: Array<{
      url: string;
      authorization: string | null;
      body: { from?: string; to?: string[]; subject?: string; text?: string };
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      captured.push({
        url: String(input),
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body)) as {
          from?: string;
          to?: string[];
          subject?: string;
          text?: string;
        },
      });
      return new Response(JSON.stringify({ id: "email_test" }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const ok = await sendPasswordResetEmail(
        {
          FLAREMO_EMAIL_PROVIDER: "resend",
          FLAREMO_EMAIL_FROM: "FlareMo <no-reply@example.com>",
          RESEND_API_KEY: "re_test_placeholder",
        } as never,
        {} as never,
        baseInput("en-US"),
      );
      expect(ok).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe("https://api.resend.com/emails");
      expect(captured[0].authorization).toBe("Bearer re_test_placeholder");
      expect(captured[0].body.from).toBe("FlareMo <no-reply@example.com>");
      expect(captured[0].body.to).toEqual(["user@example.com"]);
      expect(captured[0].body.subject).toBe(
        emailCopy("en-US").resetPassword.subject,
      );
      expect(captured[0].body.text).toContain(
        "https://app.example.com/reset?token=tok",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
