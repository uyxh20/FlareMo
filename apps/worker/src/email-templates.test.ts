import { describe, expect, it } from "vitest";
import {
  type SendVerificationEmailInput,
  sendEmailChangeVerificationEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "./email";
import { emailCopy, interpolate, pickEmailLocale } from "./email-templates";

function pickLocale(input: string | null): string {
  return pickEmailLocale(input);
}

describe("pickEmailLocale", () => {
  it("matches direct tags and q-value ordering", () => {
    expect(pickLocale("ja")).toBe("ja");
    expect(pickLocale("zh-CN")).toBe("zh-CN");
    expect(pickLocale("en-US,en;q=0.9")).toBe("en-US");
    expect(pickLocale("zh-TW,zh;q=0.9")).toBe("zh-CN");
  });

  it("falls back to the highest-quality supported prefix", () => {
    expect(pickLocale("fr-CA;q=0.8,en;q=0.9")).toBe("en-US");
    expect(pickLocale("ko-KR")).toBe("ko");
    expect(pickLocale("ru")).toBe("ru");
    expect(pickLocale("ar-EG")).toBe("ar");
    expect(pickLocale("es-MX,es;q=0.8")).toBe("es");
  });

  it("defaults to en-US for unknown or missing headers", () => {
    expect(pickLocale(null)).toBe("en-US");
    expect(pickLocale("")).toBe("en-US");
    expect(pickLocale("xx-YY,de;q=0.9")).toBe("en-US");
  });
});

describe("email copy coverage", () => {
  const locales = [
    "zh-CN",
    "en-US",
    "ja",
    "fr",
    "es",
    "ko",
    "ru",
    "ar",
  ] as const;

  it("every locale provides all three emails with placeholder-free copy", () => {
    for (const locale of locales) {
      const copy = emailCopy(locale);
      for (const email of [
        copy.verifyEmail,
        copy.resetPassword,
        copy.changeEmail,
      ]) {
        expect(email.subject.length).toBeGreaterThan(0);
        expect(email.heading.length).toBeGreaterThan(0);
        expect(email.body.length).toBeGreaterThan(0);
        expect(email.button.length).toBeGreaterThan(0);
        expect(email.ignore.length).toBeGreaterThan(0);
        for (const value of Object.values(email)) {
          expect(value).not.toMatch(/\{[a-z]+\}/);
        }
      }
      expect(copy.pasteLink).toContain("{url}");
      expect(copy.expiresHours).toContain("{hours}");
    }
  });
});

describe("localized sends", () => {
  type Captured = {
    to: string;
    from: string;
    subject: string;
    html: string;
    text: string;
  };

  function envWithBinding() {
    const sent: Captured[] = [];
    const env = {
      FLAREMO_EMAIL_PROVIDER: "cloudflare",
      FLAREMO_EMAIL_FROM: "no-reply@example.com",
      EMAIL: {
        send: async (msg: unknown) => {
          sent.push(msg as Captured);
        },
      },
    };
    return { env, sent };
  }

  const baseInput = (
    acceptLanguage: string | null,
  ): SendVerificationEmailInput => ({
    to: "user@example.com",
    token: "tok",
    publicUrl: "https://app.example.com",
    acceptLanguage,
  });

  it("renders the Japanese reset email when requested in Japanese", async () => {
    const { env, sent } = envWithBinding();
    const ok = await sendPasswordResetEmail(
      env,
      {} as never,
      baseInput("ja,en;q=0.5"),
    );
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(emailCopy("ja").resetPassword.subject);
    expect(sent[0].text).toContain("https://app.example.com/reset?token=tok");
    expect(sent[0].html).toContain(emailCopy("ja").resetPassword.button);
  });

  it("renders the Arabic change-email HTML right-to-left", async () => {
    const { env, sent } = envWithBinding();
    const ok = await sendEmailChangeVerificationEmail(
      env,
      {} as never,
      baseInput("ar"),
    );
    expect(ok).toBe(true);
    expect(sent[0].html).toContain('dir="rtl"');
    expect(sent[0].html).toContain(emailCopy("ar").changeEmail.body);
  });

  it("keeps the zh-CN verification email when requested in Chinese", async () => {
    const { env, sent } = envWithBinding();
    const ok = await sendVerificationEmail(
      env,
      {} as never,
      baseInput("zh-CN,zh;q=0.9"),
    );
    expect(ok).toBe(true);
    expect(sent[0].subject).toBe(emailCopy("zh-CN").verifyEmail.subject);
  });

  it("falls back to English copy for unmatched languages", async () => {
    const { env, sent } = envWithBinding();
    const ok = await sendVerificationEmail(
      env,
      {} as never,
      baseInput("de-DE"),
    );
    expect(ok).toBe(true);
    expect(sent[0].subject).toBe(emailCopy("en-US").verifyEmail.subject);
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

describe("interpolate", () => {
  it("replaces named params and leaves unknown ones", () => {
    expect(interpolate("{hours}h {url}", { hours: 24, url: "https://x" })).toBe(
      "24h https://x",
    );
    expect(interpolate("{missing}")).toBe("{missing}");
  });
});
