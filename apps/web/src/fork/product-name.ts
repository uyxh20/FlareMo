// Fork-owned product-name hook for the web i18n layer. `t()` in src/i18n.tsx
// calls brandTemplate on each catalog template, so the catalogs keep the
// upstream word and the fork renames the product without touching eight
// locale files. See docs/fork-customizations.md ("Product name").
import { FORK_PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from "@flaremo/contracts";

/**
 * Catalog keys that name a repo or folder, not the product. The example
 * project path "FlareMo" stays: someone typing their own repo name needs that
 * example to match the folder they have.
 */
export const PRODUCT_NAME_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "memory.composerCustomProjectPrompt",
]);

/**
 * Keys that describe the stock brand itself ("Default: FlareMo"). They always
 * show the fork default, never the owner's custom name, so the sentence still
 * reads true when a custom name is set.
 */
export const STOCK_BRAND_KEYS: ReadonlySet<string> = new Set([
  "admin.branding.productNamePlaceholder",
  "admin.branding.statusDefault",
]);

const UPSTREAM_WORD = new RegExp(`\\b${UPSTREAM_PRODUCT_NAME}\\b`, "g");

/**
 * The catalog template with the upstream brand word replaced by the product
 * name in effect. Apply it to the template only, before parameters are
 * interpolated, so user content passed as a parameter is never rewritten.
 */
export function brandTemplate(
  key: string,
  template: string,
  product: string,
): string {
  if (PRODUCT_NAME_EXCLUDED_KEYS.has(key)) return template;
  const name =
    STOCK_BRAND_KEYS.has(key) || !product ? FORK_PRODUCT_NAME : product;
  // A replacer function keeps `$` sequences in a custom name from being read
  // as replacement patterns.
  return template.replace(UPSTREAM_WORD, () => name);
}
