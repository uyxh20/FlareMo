import { getBranding, getPublicShareByToken } from "@flaremo/domain";
import type { Context, Hono } from "hono";
import { SitemapIndexStream, streamToPromise } from "sitemap";
import { getFlareMoDb, type HonoBindings } from "../context";
import {
  attachmentImageDimensions,
  contentToPlainText,
  createSanitizedMarked,
  escapeHtml,
  truncate,
} from "./markdown-render";

/**
 * Public memo share pages (`/share/:token`) as standalone lightweight HTML
 * (docs/seo-share-pages-best-practices.md, P1 strategy B).
 *
 * The web app is a pure SPA that would hand every crawler and social scraper
 * an empty 3KB shell, and it loads the whole React bundle just to show one
 * memo. This route serves a zero-JS, server-rendered document instead:
 *
 * - full SEO meta: unique title/description, canonical, Open Graph + Twitter
 *   card (image dimensions/alt from attachment payloads), JSON-LD, og:locale
 * - real rendered markdown (the shared sanitized marked pipeline, which
 *   mirrors the web app's react-markdown + remark-gfm behavior)
 * - body images resolved anonymously via `?share_token=` (the same contract
 *   the SPA share page uses) with intrinsic width/height to avoid CLS
 * - dead shares (revoked / expired / unknown tokens) return a tiny noindex
 *   page with status 404 instead of a soft-404 200
 * - `/sitemap.xml` serves a sitemapindex pointing at the enumerable public
 *   surface (articles); share tokens stay unenumerable by design
 */

const DESCRIPTION_MAX_CHARS = 160;
const HEADLINE_MAX_CHARS = 80;
const JSONLD_TEXT_MAX_CHARS = 20_000;
const SHARE_HTML_CACHE_CONTROL = "public, max-age=60, must-revalidate";

type SharePageEnv = Context<HonoBindings>["env"];

function publicOrigin(env: SharePageEnv, request: Request): string {
  const configured = env.FLAREMO_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

function utcDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

type SharePageData = Awaited<ReturnType<typeof getPublicShareByToken>>;
type ShareAttachment = SharePageData["attachments"][number];

// ---------------------------------------------------------------------------
// Attachment references. Mirrors apps/web/src/lib/attachment-refs.ts — the
// worker cannot import from the web app, so keep the two in sync (a parity
// case lives in share-page.test.ts).
// ---------------------------------------------------------------------------

const ATTACHMENT_REF = /\/file\/attachments\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export function extractReferencedAttachmentIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const match of content.matchAll(ATTACHMENT_REF)) {
    ids.add(match[1] ?? "");
  }
  return ids;
}

/** Mirrors the web helper: only markdown link destinations, fences skipped. */
export function injectShareTokenIntoFileUrls(
  content: string,
  token: string,
): string {
  let inFence = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/(\]\(\/file\/attachments\/[^\s)]*)/g, (target) =>
        target.includes("?")
          ? `${target}&share_token=${token}`
          : `${target}?share_token=${token}`,
      );
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Markdown rendering (shared sanitized pipeline in markdown-render.ts).
// ---------------------------------------------------------------------------

function createShareMarked(
  dimensionsByAttachmentId: Map<string, { width: number; height: number }>,
) {
  return createSanitizedMarked({ dimensionsByAttachmentId });
}

function renderMarkdown(input: {
  content: string;
  dimensionsByAttachmentId: Map<string, { width: number; height: number }>;
}): string {
  return createShareMarked(input.dimensionsByAttachmentId).parse(
    input.content,
    { async: false },
  );
}

// ---------------------------------------------------------------------------

function publicBlobUrl(token: string, attachment: ShareAttachment): string {
  const id = attachment.id.replace(/^attachments\//, "");
  return `/api/public/shares/${token}/attachments/${id}/blob`;
}

function renderUnreferencedAttachments(
  token: string,
  attachments: ShareAttachment[],
  content: string,
): string {
  const referenced = extractReferencedAttachmentIds(content);
  const rest = attachments.filter(
    (attachment) =>
      !referenced.has(attachment.id.replace(/^attachments\//, "")),
  );
  if (rest.length === 0) return "";
  const items = rest.map((attachment) => {
    const url = publicBlobUrl(token, attachment);
    const escapedName = escapeHtml(attachment.filename);
    if (attachment.contentType?.startsWith("image/")) {
      const dimensions = attachmentImageDimensions(attachment.payload);
      const sizeAttributes = dimensions
        ? ` width="${dimensions.width}" height="${dimensions.height}"`
        : ' loading="lazy" decoding="async"';
      return `<figure class="gallery-item"><img src="${url}?preview=1" alt="${escapedName}"${sizeAttributes} /><figcaption>${escapedName}</figcaption></figure>`;
    }
    if (attachment.contentType?.startsWith("audio/")) {
      return `<audio controls preload="none" src="${url}"></audio>`;
    }
    return `<p><a href="${url}" download>${escapedName}</a><span class="muted"> ${formatBytes(attachment.size)}</span></p>`;
  });
  return `<hr />${items.join("\n")}`;
}

function metaTag(attr: string, attrValue: string, content: string): string {
  return `<meta ${attr}="${escapeHtml(attrValue)}" content="${escapeHtml(content)}" />`;
}

type ShareMetaInput = {
  origin: string;
  token: string;
  product: string;
  faviconUrl: string | null;
  faviconType: string | null;
  data: SharePageData;
};

function firstImageAttachment(
  attachments: ShareAttachment[],
): ShareAttachment | null {
  return (
    attachments.find((attachment) =>
      attachment.contentType?.startsWith("image/"),
    ) ?? null
  );
}

function buildHeadTags(input: ShareMetaInput): string {
  const { origin, token, product, data } = input;
  const plainText = contentToPlainText(data.memo.content);
  const canonical = `${origin}/share/${token}`;
  const headline =
    truncate(plainText, HEADLINE_MAX_CHARS) || `${product} 记录分享`;
  const description = truncate(plainText, DESCRIPTION_MAX_CHARS) || product;
  const image = firstImageAttachment(data.attachments);
  const imageUrl = image
    ? `${origin}${publicBlobUrl(token, image)}?preview=1`
    : null;
  const imageDimensions = image
    ? attachmentImageDimensions(image.payload)
    : undefined;

  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    // BlogPosting: the page presents the memo as a publishable document; the
    // SocialMediaPosting type undersold long-form content to search engines.
    "@type": "BlogPosting",
    headline,
    datePublished: data.memo.createdAt,
    dateModified: data.memo.updatedAt,
    author: { "@type": "Person", name: data.user.name },
    mainEntityOfPage: canonical,
    ...(imageUrl ? { image: [imageUrl] } : {}),
  };
  if (plainText) {
    jsonLd.text = truncate(plainText, JSONLD_TEXT_MAX_CHARS);
  }
  const jsonLdScript = JSON.stringify(jsonLd)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const tags = [
    `<title>${escapeHtml(headline)}</title>`,
    metaTag("name", "description", description),
    metaTag("name", "robots", "index, follow"),
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    metaTag("property", "og:title", headline),
    metaTag("property", "og:description", description),
    metaTag("property", "og:type", "article"),
    metaTag("property", "og:url", canonical),
    metaTag("property", "og:site_name", product),
    metaTag(
      "property",
      "og:locale",
      ogLocaleFor(detectShareLang(data.memo.content)),
    ),
    metaTag("property", "article:published_time", data.memo.createdAt),
    metaTag(
      "name",
      "twitter:card",
      imageUrl ? "summary_large_image" : "summary",
    ),
    metaTag("name", "twitter:title", headline),
    metaTag("name", "twitter:description", description),
    `<script type="application/ld+json">${jsonLdScript}</script>`,
  ];
  if (imageUrl) {
    tags.push(metaTag("property", "og:image", imageUrl));
    tags.push(metaTag("name", "twitter:image", imageUrl));
    if (imageDimensions) {
      tags.push(
        metaTag("property", "og:image:width", String(imageDimensions.width)),
      );
      tags.push(
        metaTag("property", "og:image:height", String(imageDimensions.height)),
      );
    }
    tags.push(metaTag("property", "og:image:alt", image?.filename ?? ""));
  }
  return tags.join("\n    ");
}

/**
 * Best-effort content language for a shared note.
 *
 * A memo carries no declared language (the `memos` table has no such column),
 * so the alternative is guessing from the text. Only scripts that are
 * *uniquely identifying* are used: kana appear in Japanese and nowhere else in
 * our locale set, hangul only in Korean, and the Arabic block only in Arabic.
 * Shared Han is deliberately not tested — it would misclassify Simplified as
 * Japanese/Korean — so everything else keeps the zh-CN default, which matches
 * this page's Chinese chrome.
 *
 * The value drives <html lang>, which is what selects the Han *font face*:
 * without it a Japanese note renders through PingFang SC and its kana/kanji
 * take Chinese glyph forms.
 */
/** `og:locale` uses underscores ("zh_CN"); the document uses hyphens. */
function ogLocaleFor(lang: string): string {
  return lang.replace(/-/g, "_");
}

export function detectShareLang(content: string): string {
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(content)) return "ja";
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(content)) return "ko";
  if (/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff]/.test(content)) return "ar";
  return "zh-CN";
}

const SHARE_PAGE_STYLES = `
:root { color-scheme: light dark; --bg: #faf9f7; --fg: #1c1917; --muted: #78716c; --border: #e7e5e4; --accent: #c2410c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d0c0b; --fg: #e7e5e4; --muted: #a8a29e; --border: #292524; --accent: #fb923c; }
}
* { box-sizing: border-box; }
/* Han fallbacks are keyed off the <html lang> this document emits (see
   detectShareLang): font matching walks the list per character, so one shared
   Chinese-first list would paint Japanese kana/kanji with Chinese glyph forms
   and drop Korean to a last-resort face. */
:root { --font-cjk: "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei"; }
:root:lang(ja) { --font-cjk: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, "Noto Sans JP", "Noto Sans CJK JP", "PingFang SC", "Microsoft YaHei"; }
:root:lang(ko) { --font-cjk: "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", "PingFang SC", "Microsoft YaHei"; }
/* The variables sit on :root, so a subtree declaring another language (the
   Chinese-only chrome inside a Japanese note's page) would inherit the page
   list. Matching :lang() on the element lets that subtree switch back. */
:lang(zh) { --font-cjk: "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei"; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", var(--font-cjk), system-ui, sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
header, footer { max-width: 42rem; margin: 0 auto; padding: 1rem 1.25rem; }
header { border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
footer { border-top: 1px solid var(--border); color: var(--muted); font-size: .875rem; }
header a { color: var(--fg); font-weight: 600; text-decoration: none; }
header time { color: var(--muted); font-size: .875rem; }
footer a { color: var(--muted); }
article { overflow-wrap: break-word; }
article h1, article h2, article h3, article h4, article h5, article h6 { line-height: 1.3; margin: 1.6em 0 .6em; }
article h1 { font-size: 1.5rem; } article h2 { font-size: 1.3rem; } article h3 { font-size: 1.15rem; }
article p { margin: 1em 0; }
article a { color: var(--accent); }
article img { max-width: 100%; height: auto; border-radius: .5rem; }
article blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid var(--border); color: var(--muted); }
article pre { background: rgba(127,127,127,.12); padding: .9em 1em; border-radius: .5rem; overflow-x: auto; font-size: .875rem; line-height: 1.6; }
article code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; background: rgba(127,127,127,.12); padding: .15em .35em; border-radius: .25rem; }
article pre code { background: transparent; padding: 0; }
article table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .925rem; }
article th, article td { border: 1px solid var(--border); padding: .4em .7em; text-align: left; }
article hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
article ul, article ol { padding-left: 1.5em; }
article li input[type=checkbox] { margin-right: .4em; }
.gallery-item { margin: 1em 0; }
.gallery-item img { max-width: 100%; height: auto; border-radius: .5rem; }
.gallery-item figcaption { color: var(--muted); font-size: .8rem; margin-top: .3rem; }
audio { width: 100%; }
.muted { color: var(--muted); }
`;

export function renderShareDocument(input: ShareMetaInput): string {
  const { origin, token, product, data } = input;
  const dimensionsByAttachmentId = new Map<
    string,
    { width: number; height: number }
  >();
  for (const attachment of data.attachments) {
    const dimensions = attachmentImageDimensions(attachment.payload);
    if (dimensions) {
      dimensionsByAttachmentId.set(
        attachment.id.replace(/^attachments\//, ""),
        dimensions,
      );
    }
  }
  const content = injectShareTokenIntoFileUrls(data.memo.content, token);
  const bodyHtml = renderMarkdown({
    content,
    dimensionsByAttachmentId,
  });
  const galleryHtml = renderUnreferencedAttachments(
    token,
    data.attachments,
    data.memo.content,
  );
  const publishedDate = utcDate(data.memo.createdAt);

  // Derived from the note's own script so its Han text selects the right face
  // (see detectShareLang). The surrounding chrome is Chinese-only, so an RTL
  // note still renders its chrome LTR — fixing that needs translated copy.
  const lang = detectShareLang(data.memo.content);

  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#faf9f7" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0d0c0b" media="(prefers-color-scheme: dark)" />
    ${buildHeadTags(input)}
    <link
      rel="icon"
      href="${escapeHtml(input.faviconUrl ?? "/brand/flaremo-mark-light-300.png")}"
      type="${escapeHtml(input.faviconType ?? "image/png")}"
    />
    <style>${SHARE_PAGE_STYLES}</style>
  </head>
  <body>
    <header>
      <a href="${escapeHtml(origin)}/">${escapeHtml(product)}</a>
      <time datetime="${escapeHtml(data.memo.createdAt)}">${escapeHtml(publishedDate)}</time>
    </header>
    <main>
      <article data-flaremo-share-article>${bodyHtml}</article>
      ${galleryHtml}
    </main>
    <!-- The page declares the note's language; this chrome is Chinese-only
         copy, so it carries its own lang to keep Chinese glyph forms. -->
    <footer lang="zh-CN">发布于 ${escapeHtml(publishedDate)} · 作者 ${escapeHtml(data.user.name)} · <a href="${escapeHtml(origin)}">用 ${escapeHtml(product)} 打开</a></footer>
  </body>
</html>`;
}

function renderShareUnavailableDocument(product: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(product)}</title>
    <meta name="robots" content="noindex, nofollow" />
    <style>body{margin:0;min-height:100svh;display:grid;place-items:center;background:#faf9f7;color:#1c1917;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}@media (prefers-color-scheme:dark){body{background:#0d0c0b;color:#e7e5e4}}p{color:#78716c}</style>
  </head>
  <body>
    <div><strong>${escapeHtml(product)}</strong><p>该分享链接不可用或已失效。</p></div>
  </body>
</html>`;
}

const SHARE_RESPONSE_INIT = {
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": SHARE_HTML_CACHE_CONTROL,
  },
} as const;

export function registerSharePage(app: Hono<HonoBindings>): void {
  // The only enumerable public surface is published articles, so the
  // sitemap index points there. Share tokens stay unenumerable by design —
  // generating a share sitemap would leak the very links the token model
  // keeps out of search.
  app.get("/sitemap.xml", async (c) => {
    const origin = publicOrigin(c.env, c.req.raw);
    const stream = new SitemapIndexStream();
    stream.write({ url: `${origin}/sitemap-articles.xml` });
    stream.end();
    const xml = await streamToPromise(stream);
    return new Response(xml.toString(), {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=3600, must-revalidate",
      },
    });
  });

  app.get("/share/:token", async (c) => {
    const db = getFlareMoDb(c.env);
    try {
      const data = await getPublicShareByToken(db, c.req.param("token"));
      const branding = await getBranding(db);
      const input: ShareMetaInput = {
        origin: publicOrigin(c.env, c.req.raw),
        token: c.req.param("token"),
        product: branding.product,
        faviconUrl: branding.favicon
          ? `/api/app/branding/favicon?v=${encodeURIComponent(branding.favicon.updated_at)}`
          : null,
        faviconType: branding.favicon?.content_type ?? null,
        data,
      };
      return new Response(renderShareDocument(input), {
        ...SHARE_RESPONSE_INIT,
      });
    } catch {
      const branding = await getBranding(db).catch(() => null);
      const product = branding?.product ?? "FlareMo";
      return new Response(renderShareUnavailableDocument(product), {
        ...SHARE_RESPONSE_INIT,
        status: 404,
      });
    }
  });
}
