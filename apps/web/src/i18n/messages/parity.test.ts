// Locale parity gate. `TranslationKey` derives from zh-CN (see ../key.ts), and
// every catalog is type-checked against it — this test is the runtime net for
// the same invariant, so drift is caught even where types are loosened or the
// catalogs are edited dynamically. The app's `t()` falls back to en-US and
// then to the raw key (see src/i18n.tsx), so a drifted locale degrades
// silently; this test makes that degradation loud instead.
//
// Key parity alone is not enough. `interpolate` resolves `params[key] ?? match`,
// so a translation that drops or misspells a `{name}` fails in two ways that
// no type or key check can see: the caller's value is silently dropped (a
// count renders as "共 条"), and the placeholder itself leaks into the UI as
// literal `{cunt}`. Both look like a missing translation in bug reports, so
// the placeholder set is checked against the master catalog here.
import { describe, expect, it } from "vitest";
import { ar } from "./ar";
import { enUS } from "./en-US";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { ko } from "./ko";
import { ru } from "./ru";
import { zhCN } from "./zh-CN";

const CATALOGS = {
  "zh-CN": zhCN,
  "en-US": enUS,
  ja,
  fr,
  es,
  ko,
  ru,
  ar,
} as const;

/** The master catalog that `TranslationKey` is derived from. */
const MASTER = "zh-CN" as const;

function keySet(catalog: Record<string, string>): Set<string> {
  return new Set(Object.keys(catalog));
}

/** `{count}`-style slots `interpolate` resolves out of TranslationParams. */
function placeholders(template: string): Set<string> {
  return new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

describe("i18n locale key parity", () => {
  it("master catalog is non-empty", () => {
    expect(keySet(CATALOGS[MASTER]).size).toBeGreaterThan(0);
  });

  it("every locale exposes exactly the master key set", () => {
    const masterKeys = keySet(CATALOGS[MASTER]);
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      const keys = keySet(catalog);
      const missing = [...masterKeys].filter((key) => !keys.has(key));
      const extra = [...keys].filter((key) => !masterKeys.has(key));
      expect(
        { missing, extra },
        `${locale} drifted from ${MASTER}: ${missing.length} missing, ${extra.length} extra`,
      ).toEqual({ missing: [], extra: [] });
    }
  });

  it("no catalog value is empty or whitespace-only", () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(
          value.trim().length,
          `${locale}:${key} is empty`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("every locale interpolates the same placeholders as the master", () => {
    // `Object.entries` widens the key to string; the catalogs are typed as
    // exact key sets, so read through the same shape the test asserts on.
    const master = CATALOGS[MASTER] as Record<string, string>;
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      const drifted: string[] = [];
      for (const [key, value] of Object.entries(catalog)) {
        const expected = placeholders(master[key] ?? "");
        const actual = placeholders(value);
        const missing = [...expected].filter((p) => !actual.has(p));
        const extra = [...actual].filter((p) => !expected.has(p));
        if (missing.length || extra.length) {
          drifted.push(
            `${key}: missing ${missing.join(", ") || "-"},` +
              ` extra ${extra.join(", ") || "-"}`,
          );
        }
      }
      expect(
        drifted,
        `${locale} placeholder drift in ${drifted.length} key(s): ` +
          drifted.join(" | "),
      ).toEqual([]);
    }
  });
});
