import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFlareMoApp } from "../index";
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime, TEST_PASSWORD } from "../test-support/runtime";

let mf: Miniflare;
let env: Env;
let sessionCookie: string;

const {
  extractCookieHeader,
  bootstrapAndSignIn,
  fetchApp,
  createActivatedMember,
} = createAppTestHarness(() => ({
  env,
  sessionCookie,
}));

describe("FlareMo registration and email API", () => {
  beforeEach(async () => {
    ({ runtime: mf, env } = await createTestRuntime({
      databaseName: "flaremo-test",
      attachmentsName: "flaremo-attachments-test",
      env: { FLAREMO_DEPLOY_REPOSITORY: "example/flaremo" },
    }));
    sessionCookie = await bootstrapAndSignIn();
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("enforces captcha on registration when a provider is configured", async () => {
    const captchaApp = createFlareMoApp();
    // Open public registration first (owner session via admin settings).
    const open = await captchaApp.fetch(
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

    const registerWith = (requestEnv: Env, email: string, ticket?: string) =>
      captchaApp.fetch(
        new Request("http://flaremo.test/api/auth/flaremo/register", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://flaremo.test",
            ...(ticket
              ? {
                  "x-flaremo-captcha-ticket": ticket,
                  "x-flaremo-captcha-randstr": "randstr-1",
                }
              : {}),
          },
          body: JSON.stringify({
            name: "Member",
            email,
            password: TEST_PASSWORD,
          }),
        }),
        requestEnv,
      );

    // Provider `http` pointing at a stub verify endpoint: no ticket -> 403,
    // verified ticket -> 201.
    const httpEnv = {
      ...env,
      FLAREMO_CAPTCHA_PROVIDER: "http",
      FLAREMO_CAPTCHA_VERIFY_URL: "https://captcha.test/verify",
    } as Env;
    const verifyCalls: Array<{ ticket: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input).includes("captcha.test")) {
        const body = JSON.parse(String(init?.body)) as { ticket: string };
        verifyCalls.push(body);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const missing = await registerWith(httpEnv, "member@example.com");
      expect(missing.status).toBe(403);
      const withTicket = await registerWith(
        httpEnv,
        "member2@example.com",
        "ticket-abc",
      );
      expect(withTicket.status).toBe(201);
      expect(verifyCalls).toHaveLength(1);
      expect(verifyCalls[0]?.ticket).toBe("ticket-abc");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Provider `none` (default env): no captcha check at all.
    const openRegister = await registerWith(env, "member3@example.com");
    expect(openRegister.status).toBe(201);
  });

  it("sends a verification email on registration and verifies via token", async () => {
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

    const emailEnv = {
      ...env,
      FLAREMO_EMAIL_PROVIDER: "cloudflare",
      FLAREMO_EMAIL_FROM: "no-reply@flaremo.test",
    } as Env;
    const sent: Array<{ to: string; from: string; subject: string }> = [];
    const emailBinding = {
      send: async (msg: { to: string; from: string; subject: string }) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    const appWithEmail = createFlareMoApp();
    const register = await appWithEmail.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/register", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          name: "Member",
          email: "verify-me@example.com",
          password: TEST_PASSWORD,
        }),
      }),
      { ...emailEnv, EMAIL: emailBinding } as Env,
    );
    expect(register.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("verify-me@example.com");
    expect(sent[0]?.from).toBe("no-reply@flaremo.test");
    expect(sent[0]?.subject).toContain("Verify");

    // The token is not exposed in the response; verify the endpoint rejects
    // an unknown token and that the status endpoint reports verification
    // being required.
    const status = await appWithEmail.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/register/status"),
      { ...emailEnv, EMAIL: emailBinding } as Env,
    );
    const statusBody = (await status.json()) as {
      email_verification_required: boolean;
    };
    expect(statusBody.email_verification_required).toBe(true);

    const bad = await appWithEmail.fetch(
      new Request(
        "http://flaremo.test/api/auth/flaremo/verify-email?token=unknown-token",
      ),
      { ...emailEnv, EMAIL: emailBinding } as Env,
    );
    expect(bad.status).toBe(400);
  });

  it("supports resend verification, self-service reset, and verified email change", async () => {
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

    const emailEnv = {
      ...env,
      FLAREMO_EMAIL_PROVIDER: "cloudflare",
      FLAREMO_EMAIL_FROM: "no-reply@flaremo.test",
    } as Env;
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const emailBinding = {
      send: async (msg: { to: string; subject: string; text: string }) => {
        sent.push(msg);
        return { ok: true };
      },
    };
    const appEnv = { ...emailEnv, EMAIL: emailBinding } as Env;

    const register = (email: string) =>
      emailApp.fetch(
        new Request("http://flaremo.test/api/auth/flaremo/register", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://flaremo.test",
          },
          body: JSON.stringify({
            name: "Member",
            email,
            password: TEST_PASSWORD,
          }),
        }),
        appEnv,
      );
    expect((await register("lifecycle@example.com")).status).toBe(201);
    expect((await register("other@example.com")).status).toBe(201);
    expect(sent).toHaveLength(2);

    // Resend hits the known unverified address only; unknown addresses and
    // already-verified identities share the same success shape.
    const resend = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/resend-verification", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({ email: "lifecycle@example.com" }),
      }),
      appEnv,
    );
    expect(resend.status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.subject).toContain("Verify");

    const resendUnknown = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/resend-verification", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({ email: "nobody@example.com" }),
      }),
      appEnv,
    );
    expect(resendUnknown.status).toBe(200);
    expect(sent).toHaveLength(3);

    // Without an email provider both endpoints refuse outright.
    const resendNone = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/resend-verification", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({ email: "lifecycle@example.com" }),
      }),
      env,
    );
    expect(resendNone.status).toBe(400);

    // Self-service password reset: the mail carries the one-hour token, the
    // reset goes through Better Auth's own endpoint, and the old password
    // stops working.
    const forgot = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/forgot-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({ email: "lifecycle@example.com" }),
      }),
      appEnv,
    );
    expect(forgot.status).toBe(200);
    expect(sent).toHaveLength(4);
    expect(sent[3]?.subject).toContain("Reset");

    const forgotUnknown = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/flaremo/forgot-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({ email: "nobody@example.com" }),
      }),
      appEnv,
    );
    expect(forgotUnknown.status).toBe(200);
    expect(sent).toHaveLength(4);

    const resetToken = /reset\?token=([A-Za-z0-9-]+)/.exec(
      sent[3]?.text ?? "",
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
          newPassword: `${TEST_PASSWORD}-new`,
          token: resetToken,
        }),
      }),
      appEnv,
    );
    expect(reset.status).toBe(200);

    const oldPassword = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          email: "lifecycle@example.com",
          password: TEST_PASSWORD,
        }),
      }),
      appEnv,
    );
    expect(oldPassword.status).toBe(401);
    const newPassword = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          email: "lifecycle@example.com",
          password: `${TEST_PASSWORD}-new`,
        }),
      }),
      appEnv,
    );
    expect(newPassword.status).toBe(200);

    // Verified email change: the current password authorizes the request,
    // the new address confirms ownership, and only then does the login
    // identity switch.
    const signIn = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          email: "other@example.com",
          password: TEST_PASSWORD,
        }),
      }),
      appEnv,
    );
    expect(signIn.status).toBe(200);
    const memberCookie = extractCookieHeader(signIn);

    const changeRequest = await emailApp.fetch(
      new Request("http://flaremo.test/api/app/account/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
          cookie: memberCookie,
        },
        body: JSON.stringify({
          current_password: TEST_PASSWORD,
          new_email: "changed@example.com",
        }),
      }),
      appEnv,
    );
    expect(changeRequest.status).toBe(200);
    const changeBody = (await changeRequest.json()) as {
      verification_sent?: boolean;
    };
    expect(changeBody.verification_sent).toBe(true);
    expect(sent).toHaveLength(5);
    expect(sent[4]?.to).toBe("changed@example.com");

    const changeToken = /verify-email-change\?token=([A-Za-z0-9-]+)/.exec(
      sent[4]?.text ?? "",
    )?.[1];
    expect(changeToken).toBeDefined();
    const confirm = await emailApp.fetch(
      new Request(
        `http://flaremo.test/api/auth/flaremo/verify-email-change?token=${changeToken}`,
      ),
      appEnv,
    );
    expect(confirm.status).toBe(200);

    const oldEmail = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          email: "other@example.com",
          password: TEST_PASSWORD,
        }),
      }),
      appEnv,
    );
    expect(oldEmail.status).toBe(401);
    const newEmailSignIn = await emailApp.fetch(
      new Request("http://flaremo.test/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          email: "changed@example.com",
          password: TEST_PASSWORD,
        }),
      }),
      appEnv,
    );
    expect(newEmailSignIn.status).toBe(200);

    // An in-use target address is rejected before any mail is sent. The
    // conflict is a 409, not the 400 a generic validation failure would use:
    // the address belongs to another account, which is a state conflict.
    const takenRequest = await emailApp.fetch(
      new Request("http://flaremo.test/api/app/account/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
          cookie: memberCookie,
        },
        body: JSON.stringify({
          current_password: TEST_PASSWORD,
          new_email: "lifecycle@example.com",
        }),
      }),
      appEnv,
    );
    expect(takenRequest.status).toBe(409);
    expect(await takenRequest.json()).toEqual({
      error: { message: "That email is already in use." },
    });
    expect(sent).toHaveLength(5);
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

  it("sends reset mail through Better Auth forget-password when Resend is configured", async () => {
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

    const resendBodies: Array<{ subject?: string; text?: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (String(input).includes("api.resend.com")) {
        resendBodies.push(
          JSON.parse(String(init?.body)) as {
            subject?: string;
            text?: string;
          },
        );
        return new Response(JSON.stringify({ id: "email_test" }), {
          status: 200,
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const appEnv = {
      ...env,
      FLAREMO_EMAIL_PROVIDER: "resend",
      FLAREMO_EMAIL_FROM: "no-reply@flaremo.test",
      RESEND_API_KEY: "re_test_placeholder",
    } as Env;

    try {
      const register = await emailApp.fetch(
        new Request("http://flaremo.test/api/auth/flaremo/register", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://flaremo.test",
          },
          body: JSON.stringify({
            name: "Resend Member",
            email: "resend-reset@example.com",
            password: TEST_PASSWORD,
          }),
        }),
        appEnv,
      );
      expect(register.status).toBe(201);
      expect(
        resendBodies.some((mail) => mail.subject?.includes("Verify")),
      ).toBe(true);

      const forgot = await emailApp.fetch(
        new Request("http://flaremo.test/api/auth/request-password-reset", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://flaremo.test",
          },
          body: JSON.stringify({ email: "resend-reset@example.com" }),
        }),
        appEnv,
      );
      expect(forgot.status).toBe(200);
      const resetMail = resendBodies.find((mail) =>
        mail.subject?.includes("Reset"),
      );
      expect(resetMail?.text).toContain("/reset?token=");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an in-use address without an email provider configured", async () => {
    // The default test env has no provider, so this exercises the immediate
    // change branch. That branch used to skip the occupancy check entirely and
    // reach Better Auth's write, which failed on the auth email's unique index
    // and surfaced as a 500 "Internal server error".
    const member = await createActivatedMember(
      "no-provider@example.com",
      "No Provider",
    );
    const taken = await createActivatedMember(
      "occupied@example.com",
      "Occupied",
    );
    void taken;

    const response = await fetchApp(
      "http://flaremo.test/api/app/account/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
          cookie: member.cookie,
        },
        body: JSON.stringify({
          current_password: TEST_PASSWORD,
          new_email: "occupied@example.com",
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: "That email is already in use." },
    });
  });
});
