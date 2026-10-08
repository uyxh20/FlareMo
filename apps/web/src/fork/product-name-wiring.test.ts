/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The product name reaches the UI through three hook-ins in upstream files:
// t() in i18n.tsx brands every catalog template, the default branding uses the
// fork constant, and the media session reads the live product. After an
// upstream sync that drops one of them, this fails loudly instead of the UI
// quietly saying "FlareMo" again. See docs/fork-customizations.md.

const i18n = readFileSync(new URL("../i18n.tsx", import.meta.url), "utf8");
const branding = readFileSync(
  new URL("../branding.tsx", import.meta.url),
  "utf8",
);
const audio = readFileSync(
  new URL("../components/reading/reading-audio-provider.tsx", import.meta.url),
  "utf8",
);

describe("the product-name hook-ins", () => {
  it("i18n.tsx imports brandTemplate from the fork module", () => {
    expect(i18n).toMatch(
      /import\s*\{[^}]*\bbrandTemplate\b[^}]*\}\s*from\s*["']\.\/fork\/product-name["']/,
    );
  });

  it("i18n.tsx brands each template with the live product before interpolating", () => {
    expect(i18n).toMatch(
      /interpolate\(\s*brandTemplate\(key,\s*template,\s*product\),\s*params\s*\)/,
    );
  });

  it("i18n.tsx reads the product from branding", () => {
    expect(i18n).toMatch(/const\s*\{\s*product\s*\}\s*=\s*useBranding\(\)/);
  });

  it("the default branding uses the fork constant", () => {
    expect(branding).toMatch(/product:\s*FORK_PRODUCT_NAME,/);
  });

  it("the media session metadata uses the live product", () => {
    expect(audio).toMatch(/artist:\s*product,/);
    expect(audio).toMatch(/album:\s*product,/);
  });
});
