import type { HighlighterCore } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * Shiki highlighter for the SSR article page. The JS regex engine (no WASM)
 * runs in Cloudflare Workers; languages load lazily per requested code fence
 * and unknown languages degrade to plain text. Dual themes render as CSS
 * variables (`defaultColor: false`), so the page stylesheet picks light/dark
 * at display time instead of baking one theme into the HTML.
 *
 * One highlighter instance per isolate, cached in module scope: the article
 * page is an anonymous surface, and rebuilding the core per request was both
 * wasteful and racy (concurrent requests overwrote a per-request singleton
 * mid-render). Language loads are deduplicated per language.
 */

// Dynamic imports stay inside factories so importing this module (which the
// worker entry does for every request) does not fetch ~12 shiki grammars.
// The promises are only created when the article page actually highlights.
const loadThemes = () =>
  [
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
  ] as const;

const LANG_IMPORTS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
};

const PLAIN_LANGS = new Set(["text", "plain", "txt", ""]);

function resolveLanguage(raw: string): string {
  const lang = raw.trim().toLowerCase();
  if (PLAIN_LANGS.has(lang)) return "text";
  // Fence aliases resolve to the module that will actually be loaded; tsx and
  // jsx are separate grammars (not aliases of their base languages).
  if (lang === "ts") return "typescript";
  if (lang === "js" || lang === "mjs") return "javascript";
  if (lang === "shell" || lang === "sh") return "bash";
  return LANG_IMPORTS[lang] ? lang : "text";
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoads = new Map<string, Promise<void>>();
let ready: HighlighterCore | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: loadThemes() as never,
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterPromise;
}

async function ensureLanguage(
  instance: HighlighterCore,
  lang: string,
): Promise<void> {
  let load = languageLoads.get(lang);
  if (!load) {
    const langImport = LANG_IMPORTS[lang];
    if (!langImport) return;
    load = instance
      .loadLanguage(langImport() as never)
      .then(() => {
        if (ready === null) ready = instance;
      })
      .catch((error) => {
        // Drop the failed entry so a later request can retry; the render
        // falls back to a plain code block either way.
        languageLoads.delete(lang);
        throw error;
      });
    languageLoads.set(lang, load);
  }
  await load;
  if (ready === null) ready = instance;
}

/**
 * Scans the article's code fences and loads every supported language before
 * parsing, so the render path below stays synchronous (marked's sync
 * contract).
 */
export async function initArticleHighlighter(content: string): Promise<void> {
  const instance = await getHighlighter();
  const requested = new Set<string>();
  for (const match of content.matchAll(/^\s*```([A-Za-z0-9_-]*)/gm)) {
    const lang = resolveLanguage(match[1] ?? "");
    if (lang !== "text") requested.add(lang);
  }
  await Promise.all(
    [...requested].map((lang) => ensureLanguage(instance, lang)),
  );
}

/**
 * Sync highlight for the article renderer's `code` override. Returning an
 * empty string lets the caller fall back to the escaped-plain-code block
 * (unknown language, or highlighter unavailable).
 *
 * Why not marked-highlight: its v2 renderer always wraps the highlighted
 * payload in a plain `<pre><code>`, which would double-wrap Shiki's own
 * `<pre class="shiki">` output. The one-line fallback below is integration
 * glue; all highlighting remains Shiki's.
 */
export function highlightArticleCode(code: string, lang: string): string {
  const instance = ready;
  if (!instance) return "";
  const language = resolveLanguage(lang);
  if (language === "text") return "";
  if (!instance.getLoadedLanguages().includes(language)) return "";
  try {
    return instance.codeToHtml(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  } catch {
    return "";
  }
}
