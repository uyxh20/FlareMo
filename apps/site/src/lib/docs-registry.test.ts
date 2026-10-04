/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listDocs } from "./docs-source.generated";

/**
 * Docs registry consistency contract for the marketing site.
 *
 * Publishing a doc takes three hand-maintained edits: the markdown file, the
 * ZH_DOCS/EN_DOCS entry in `docs-source.generated.ts`, and the DOC_SLUGS array
 * in `scripts/build.mjs`. Nothing compared them, so every omission failed
 * silently in a different direction:
 *
 *   - a slug in DOC_SLUGS but missing from ZH_DOCS made the SSG loader render
 *     "Document not found" into a prerendered page — a 200 that ships a hole;
 *   - an English translation written to `docs/en/` but left marked
 *     `fallbackFromZh: true` stayed out of `listDocs` and never reached the
 *     English sidebar or sitemap, with no error anywhere;
 *   - a markdown file added without a registry entry was never built at all.
 *
 * The two registries must agree with each other and with what is on disk.
 */

// scripts/build.mjs is a top-level build script, so importing it would run a
// full site build. Read the array as text instead.
const buildScript = readFileSync(
  new URL("../../scripts/build.mjs", import.meta.url),
  "utf8",
);

const DOC_SLUGS: string[] = (() => {
  const block = buildScript.match(/const DOC_SLUGS = \[([\s\S]*?)\];/);
  if (!block) throw new Error("DOC_SLUGS is missing from scripts/build.mjs");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
})();

/** Repo-root-relative; the registry imports markdown four levels up. */
const markdownSlugs = (dir: string): string[] =>
  readdirSync(new URL(`../../../../${dir}`, import.meta.url))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .sort();

describe("docs SSG slug list", () => {
  it("matches the Chinese registry entry for entry", () => {
    expect(DOC_SLUGS).toEqual(listDocs("zh-CN").map((doc) => doc.slug));
  });

  it("points at markdown files that exist", () => {
    const onDisk = new Set(markdownSlugs("docs"));
    for (const slug of DOC_SLUGS) {
      expect(onDisk, `DOC_SLUGS publishes ${slug}`).toContain(slug);
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(DOC_SLUGS).size).toBe(DOC_SLUGS.length);
  });
});

describe("English translations", () => {
  it("exposes every file under docs/en/ as a real translation", () => {
    // listDocs filters fallbackFromZh entries out, so this fails when a
    // translation is written but the marker is left behind — the case that
    // keeps a finished page off the site without a single error.
    const exposed = listDocs("en-US")
      .map((doc) => doc.slug)
      .sort();
    expect(exposed).toEqual(markdownSlugs("docs/en"));
  });

  it("only publishes English slugs that Chinese also has", () => {
    const zh = new Set(listDocs("zh-CN").map((doc) => doc.slug));
    for (const doc of listDocs("en-US")) {
      expect(zh, `English slug ${doc.slug}`).toContain(doc.slug);
    }
  });
});

describe("descriptions", () => {
  it("gives every Chinese doc a directory-page description", () => {
    for (const doc of listDocs("zh-CN")) {
      expect(doc.description, `description for ${doc.slug}`).not.toBe("");
    }
  });
});
