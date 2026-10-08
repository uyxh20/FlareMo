// Fork-owned product identity (uyxh20/FlareMo). The name every user sees
// when no admin has set a custom product name. Worker and web both import
// it, so a rename is one edit here. See docs/fork-customizations.md
// ("Product name") for the hook-ins and what was deliberately left alone.

/** The product name shown in the UI, emails, notifications and page titles. */
export const FORK_PRODUCT_NAME = "Schizo Diary";

/**
 * The upstream brand word that appears in translated text. The web i18n
 * hook replaces this word with the live product name, so a catalog never
 * has to be rewritten to rename the product.
 */
export const UPSTREAM_PRODUCT_NAME = "FlareMo";
