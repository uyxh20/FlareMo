import { FORK_PRODUCT_NAME } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import { ar } from "../i18n/messages/ar";
import { enUS } from "../i18n/messages/en-US";
import { es } from "../i18n/messages/es";
import { fr } from "../i18n/messages/fr";
import { ja } from "../i18n/messages/ja";
import { ko } from "../i18n/messages/ko";
import { ru } from "../i18n/messages/ru";
import { zhCN } from "../i18n/messages/zh-CN";
import {
  brandTemplate,
  PRODUCT_NAME_EXCLUDED_KEYS,
  STOCK_BRAND_KEYS,
} from "./product-name";

const CATALOGS: Record<string, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  ja,
  fr,
  es,
  ko,
  ru,
  ar,
};

describe("brandTemplate", () => {
  it("replaces the upstream word with a custom product name", () => {
    expect(brandTemplate("auth.loginTitle", "Sign in to FlareMo", "Acme")).toBe(
      "Sign in to Acme",
    );
  });

  it("uses the fork name when the product is empty", () => {
    expect(brandTemplate("auth.loginTitle", "Sign in to FlareMo", "")).toBe(
      `Sign in to ${FORK_PRODUCT_NAME}`,
    );
  });

  it("replaces the word in every position, including before Korean particles", () => {
    expect(
      brandTemplate("capture.description", "FlareMo가 FlareMo, FlareMo's", "A"),
    ).toBe("A가 A, A's");
  });

  it("does not read $ sequences in a custom name as replacement patterns", () => {
    expect(brandTemplate("auth.loginTitle", "Sign in to FlareMo", "A$&B")).toBe(
      "Sign in to A$&B",
    );
  });

  it("leaves identifiers that only contain the brand word alone", () => {
    const template = "Set FLAREMO_TRUSTED_ORIGINS and FlareMoX";
    expect(brandTemplate("toast.untrustedOrigin", template, "Acme")).toBe(
      template,
    );
  });

  it("keeps the upstream word on excluded keys", () => {
    const key = "memory.composerCustomProjectPrompt";
    expect(PRODUCT_NAME_EXCLUDED_KEYS.has(key)).toBe(true);
    expect(brandTemplate(key, "e.g. FlareMo or /Users/...", "Acme")).toBe(
      "e.g. FlareMo or /Users/...",
    );
  });

  it("shows the fork default on stock-brand keys, whatever the custom name", () => {
    for (const key of STOCK_BRAND_KEYS) {
      expect(brandTemplate(key, "Default: FlareMo", "Acme")).toBe(
        `Default: ${FORK_PRODUCT_NAME}`,
      );
    }
  });
});

describe("catalog coverage", () => {
  it("brands every catalog key that names FlareMo, except the excluded ones", () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [key, template] of Object.entries(catalog)) {
        if (!template.includes("FlareMo")) continue;
        const branded = brandTemplate(key, template, "Acme");
        if (PRODUCT_NAME_EXCLUDED_KEYS.has(key)) {
          expect(branded, `${locale} ${key}`).toContain("FlareMo");
        } else {
          expect(branded, `${locale} ${key}`).not.toMatch(/\bFlareMo\b/);
        }
      }
    }
  });

  it("keeps every excluded key and stock-brand key present in every catalog", () => {
    // A stale entry would silently stop matching; this keeps the lists honest.
    for (const key of [...PRODUCT_NAME_EXCLUDED_KEYS, ...STOCK_BRAND_KEYS]) {
      for (const [locale, catalog] of Object.entries(CATALOGS)) {
        expect(catalog, `${locale} is missing ${key}`).toHaveProperty(key);
      }
    }
  });
});
