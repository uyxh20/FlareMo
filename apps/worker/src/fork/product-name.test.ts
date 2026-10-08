import { FORK_PRODUCT_NAME } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { describe, expect, it } from "vitest";
import { brandCopy, brandText, resolveProductName } from "./product-name";

describe("brandText", () => {
  it("replaces the upstream brand word with the fork name", () => {
    expect(brandText("Welcome to FlareMo!")).toBe(
      `Welcome to ${FORK_PRODUCT_NAME}!`,
    );
  });

  it("replaces every occurrence, next to CJK text and punctuation", () => {
    expect(brandText("FlareMo、FlareMo和FlareMo。")).toBe(
      `${FORK_PRODUCT_NAME}、${FORK_PRODUCT_NAME}和${FORK_PRODUCT_NAME}。`,
    );
  });

  it("leaves identifiers that only contain the brand word alone", () => {
    const text = "Set FLAREMO_TRUSTED_ORIGINS, FlareMoX and flaremo.locale.";
    expect(brandText(text)).toBe(text);
  });
});

describe("brandCopy", () => {
  it("brands every string in a nested copy table and keeps other values", () => {
    const copy = {
      subject: "Verify your FlareMo email",
      nested: { body: "Welcome to FlareMo!", count: 2 },
      list: ["FlareMo", "plain"],
      flag: true,
    };
    expect(brandCopy(copy)).toEqual({
      subject: `Verify your ${FORK_PRODUCT_NAME} email`,
      nested: { body: `Welcome to ${FORK_PRODUCT_NAME}!`, count: 2 },
      list: [FORK_PRODUCT_NAME, "plain"],
      flag: true,
    });
  });

  it("does not mutate its input", () => {
    const copy = { subject: "FlareMo" };
    brandCopy(copy);
    expect(copy.subject).toBe("FlareMo");
  });
});

describe("resolveProductName", () => {
  it("degrades to the fork default when the branding read fails", async () => {
    // A handle with no query builder makes getBranding throw; the message is
    // still sent, under the default name.
    await expect(resolveProductName({} as FlareMoDb)).resolves.toBe(
      FORK_PRODUCT_NAME,
    );
  });
});
