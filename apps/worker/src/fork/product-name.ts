// Fork-owned product-name helpers for the worker. See
// docs/fork-customizations.md ("Product name").
import { FORK_PRODUCT_NAME, UPSTREAM_PRODUCT_NAME } from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { getBranding } from "@flaremo/domain";

/**
 * The name to show in worker-sent text that has a database handle: the
 * owner's custom product name when one is set, else the fork default.
 * A failed read degrades to the default rather than dropping the message.
 */
export async function resolveProductName(db: FlareMoDb): Promise<string> {
  try {
    return (await getBranding(db)).product;
  } catch {
    return FORK_PRODUCT_NAME;
  }
}

const UPSTREAM_WORD = new RegExp(`\\b${UPSTREAM_PRODUCT_NAME}\\b`, "g");

/** Replaces the upstream brand word with the fork name in one string. */
export function brandText(text: string): string {
  // A replacer function keeps `$` sequences in the name from being read as
  // replacement patterns.
  return text.replace(UPSTREAM_WORD, () => FORK_PRODUCT_NAME);
}

/**
 * Applies `brandText` to every string in a static copy table. Emails use this
 * because their copy is fixed per locale and has no database handle, so an
 * admin-set product name does not reach them (see docs/fork-customizations.md).
 */
export function brandCopy<T>(value: T): T {
  if (typeof value === "string") return brandText(value) as T;
  if (Array.isArray(value)) return value.map((item) => brandCopy(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, brandCopy(item)]),
    ) as T;
  }
  return value;
}
