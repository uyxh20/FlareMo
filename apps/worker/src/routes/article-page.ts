import { articles, users } from "@flaremo/db";
import {
  getBranding,
  getPublicArticleBySlug,
  type PublicArticle,
} from "@flaremo/domain";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { Feed } from "feed";
import type { Context, Hono } from "hono";
import { gfmHeadingId } from "marked-gfm-heading-id";
import type { BlogPosting, WithContext } from "schema-dts";
import { SitemapStream, streamToPromise } from "sitemap";
import { getFlareMoDb, type HonoBindings } from "../context";
import {
  attachmentImageDimensions,
  contentToPlainText,
  createSanitizedMarked,
  escapeHtml,
  truncate,
} from "./markdown-render";
import {
  highlightArticleCode,
  initArticleHighlighter,
} from "./shiki-highlighter";

/**
 * Public article pages (`/article/:slug`) as standalone zero-JS HTML — the
 * published face of FlareMo articles (docs/article-publishing-design.md).
 * Built on the same infrastructure as the memo share page (standalone HTML,
 * full meta, attachment payload dimensions), with article-specific contracts:
 *
 * - title/description from the article's own fields, JSON-LD BlogPosting
 *   (schema-dts typed), article:published/modified_time, og:locale from the
 *   article's lang (no hardcoding)
 * - Shiki code highlighting (dual themes via CSS variables) and GFM heading
 *   ids (marked-gfm-heading-id, the official marked extension)
 * - `/sitemap-articles.xml` enumerates published articles (the share-token
 *   model stays unenumerable); `/feed.xml` is a full-content RSS 2.0 feed
 * - dead slugs (draft / deleted / unknown) return noindex 404s
 */

const DESCRIPTION_MAX_CHARS = 160;
const ARTICLE_HTML_CACHE_CONTROL = "public, max-age=300, must-revalidate";
const SYNDICATION_CACHE_CONTROL = "public, max-age=3600, must-revalidate";
const FEED_SIZE = 50;

type ArticlePageEnv = Context<HonoBindings>["env"];

type ArticlePageData = PublicArticle;
type ArticleAttachment = ArticlePageData["attachments"][number];

function publicOrigin(env: ArticlePageEnv, request: Request): string {
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

// ---------------------------------------------------------------------------
// Markdown rendering. Reuses the share page's sanitized pipeline, extended
// with GFM heading ids and Shiki code highlighting.
// ---------------------------------------------------------------------------

const ATTACHMENT_REF = /\/file\/attachments\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/**
 * Body attachment references point at the authenticated `/file/` surface;
 * the public page rewrites them to the article's anonymous blob contract
 * (fences skipped, same shape as the share page's token injection). `origin`
 * prefixes the URLs for syndication contexts (RSS readers cannot resolve
 * relative image sources).
 */
export function rewriteArticleFileUrls(
  content: string,
  slug: string,
  origin?: string,
): string {
  const base = origin ? origin.replace(/\/+$/, "") : "";
  let inFence = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/(\]\(\/file\/attachments\/[^\s)]*)/g, (match) => {
        const id = /\/file\/attachments\/([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(
          match,
        )?.[1];
        if (!id) return match;
        // The replacement drops the original filename (and its query) from
        // the match, so a surviving query must be re-attached with `?` — the
        // separator the match consumed. (The old `&` form produced URLs like
        // `/blob&w=320`, which no longer match this route at all.)
        const query = match.includes("?")
          ? `?${match.split("?").slice(1).join("?")}`
          : "";
        return `](${base}/api/public/articles/${encodeURIComponent(slug)}/attachments/${id}/blob${query}`;
      });
    })
    .join("\n");
}

function createArticleMarked(
  dimensionsByAttachmentId: Map<string, { width: number; height: number }>,
) {
  const marked = createSanitizedMarked({ dimensionsByAttachmentId });
  // gfm-heading-id: official marked extension; stable anchor ids for every
  // heading (deep links + future TOC consumers).
  marked.use(gfmHeadingId({ prefix: "" }));
  marked.use({
    async: false,
    renderer: {
      // Shiki's codeToHtml emits its own `<pre class="shiki">` wrapper (see
      // shiki-highlighter.ts for why marked-highlight's wrapper conflicts).
      code(token) {
        const highlighted = highlightArticleCode(token.text, token.lang ?? "");
        if (highlighted) return highlighted;
        const language = (token.lang ?? "").match(/\S*/)?.[0] ?? "";
        const classAttr = language
          ? ` class="language-${escapeHtml(language)}"`
          : "";
        return `<pre><code${classAttr}>${escapeHtml(token.text)}\n</code></pre>`;
      },
    },
  });
  return marked;
}

// ---------------------------------------------------------------------------

function articleBlobUrl(slug: string, attachmentId: string): string {
  return `/api/public/articles/${encodeURIComponent(slug)}/attachments/${attachmentId}/blob`;
}

function renderUnreferencedAttachments(data: ArticlePageData): string {
  const referenced = extractReferencedAttachmentIds(data.article.content);
  const rest = data.attachments.filter(
    (attachment) =>
      !referenced.has(attachment.id.replace(/^attachments\//, "")),
  );
  if (rest.length === 0) return "";
  const items = rest.map((attachment) => {
    const url = articleBlobUrl(
      data.article.slug,
      attachment.id.replace(/^attachments\//, ""),
    );
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

export function extractReferencedAttachmentIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const match of content.matchAll(ATTACHMENT_REF)) {
    ids.add(match[1] ?? "");
  }
  return ids;
}

function metaTag(attr: string, attrValue: string, content: string): string {
  return `<meta ${attr}="${escapeHtml(attrValue)}" content="${escapeHtml(content)}" />`;
}

export function ogLocale(lang: string | null): string {
  const raw = lang?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  if (!raw) return "zh_CN";
  // og:locale is language_TERRITORY ("zh_CN"), not the raw BCP-47 tag.
  const [language, region] = raw.split("_");
  return region ? `${language}_${region.toUpperCase()}` : (language ?? raw);
}

/** The cover attachment, or the first image bound to the article. */
function ogImageAttachment(data: ArticlePageData): ArticleAttachment | null {
  if (data.article.coverAttachmentId) {
    const cover = data.attachments.find(
      (attachment) => attachment.id === data.article.coverAttachmentId,
    );
    if (cover) return cover;
  }
  return (
    data.attachments.find((attachment) =>
      attachment.contentType?.startsWith("image/"),
    ) ?? null
  );
}

type ArticleMetaInput = {
  origin: string;
  product: string;
  faviconUrl: string | null;
  faviconType: string | null;
  data: ArticlePageData;
};

export function buildArticleHeadTags(input: ArticleMetaInput): string {
  const { origin, product, data } = input;
  const { article, user } = data;
  const canonical = `${origin}/article/${encodeURIComponent(article.slug)}`;
  const headline = article.title.trim() || `${product} 文章`;
  const description =
    article.description?.trim() ||
    truncate(contentToPlainText(article.content), DESCRIPTION_MAX_CHARS) ||
    product;
  const image = ogImageAttachment(data);
  const imageUrl = image
    ? `${origin}${articleBlobUrl(article.slug, image.id.replace(/^attachments\//, ""))}?preview=1`
    : null;
  const imageDimensions = image
    ? attachmentImageDimensions(image.payload)
    : undefined;

  const jsonLd: WithContext<BlogPosting> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: truncate(headline, 110),
    description: truncate(description, 300),
    datePublished: article.publishedAt ?? article.createdAt,
    dateModified: article.updatedAt,
    author: { "@type": "Person", name: user.name },
    mainEntityOfPage: canonical,
    ...(imageUrl ? { image: [imageUrl] } : {}),
    ...(article.lang ? { inLanguage: article.lang } : {}),
  };
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
    metaTag("property", "og:locale", ogLocale(article.lang)),
    metaTag(
      "property",
      "article:published_time",
      article.publishedAt ?? article.createdAt,
    ),
    metaTag("property", "article:modified_time", article.updatedAt),
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

const ARTICLE_PAGE_STYLES = `
:root { color-scheme: light dark; --bg: #faf9f7; --fg: #1c1917; --muted: #78716c; --border: #e7e5e4; --accent: #c2410c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d0c0b; --fg: #e7e5e4; --muted: #a8a29e; --border: #292524; --accent: #fb923c; }
}
* { box-sizing: border-box; }
/* Han fallbacks are keyed off the <html lang> this document already emits:
   font matching walks the family list per character, so one shared list would
   hand Japanese kana/kanji to a Chinese face and paint them with Chinese
   glyph forms. The first block stays the default for every other locale. */
:root { --font-cjk: "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei"; }
:root:lang(ja) { --font-cjk: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, "Noto Sans JP", "Noto Sans CJK JP", "PingFang SC", "Microsoft YaHei"; }
:root:lang(ko) { --font-cjk: "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", "PingFang SC", "Microsoft YaHei"; }
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
article h1 { font-size: 1.6rem; } article h2 { font-size: 1.35rem; } article h3 { font-size: 1.2rem; }
article h1, article h2, article h3 { scroll-margin-top: 1rem; }
article p { margin: 1em 0; }
article a { color: var(--accent); }
article img { max-width: 100%; height: auto; border-radius: .5rem; }
article blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid var(--border); color: var(--muted); }
article pre { background: rgba(127,127,127,.12); padding: .9em 1em; border-radius: .5rem; overflow-x: auto; font-size: .875rem; line-height: 1.6; }
article code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; background: rgba(127,127,127,.12); padding: .15em .35em; border-radius: .25rem; }
article pre code { background: transparent; padding: 0; }
/* Shiki dual themes: colors arrive as CSS variables (defaultColor: false). */
article pre.shiki { background-color: var(--shiki-light-bg); }
article pre.shiki span { color: var(--shiki-light); }
@media (prefers-color-scheme: dark) {
  article pre.shiki { background-color: var(--shiki-dark-bg); }
  article pre.shiki span { color: var(--shiki-dark); }
}
article table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .925rem; }
article th, article td { border: 1px solid var(--border); padding: .4em .7em; text-align: start; }
article hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
article ul, article ol { padding-inline-start: 1.5em; }
article li input[type=checkbox] { margin-inline-end: .4em; }
.gallery-item { margin: 1em 0; }
.gallery-item img { max-width: 100%; height: auto; border-radius: .5rem; }
.gallery-item figcaption { color: var(--muted); font-size: .8rem; margin-top: .3rem; }
audio { width: 100%; }
.muted { color: var(--muted); }
`;

function htmlLang(lang: string | null): string {
  return (lang?.trim() || "zh-CN").replace(/_/g, "-");
}

/** Arabic is the only RTL language in the supported set. */
function isRtlLang(lang: string | null): boolean {
  return /^ar\b/i.test(lang?.trim() ?? "");
}

export function renderArticleDocument(input: ArticleMetaInput): string {
  const { origin, product, data } = input;
  const { article, user } = data;
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
  const content = rewriteArticleFileUrls(article.content, article.slug);
  const bodyHtml = createArticleMarked(dimensionsByAttachmentId).parse(
    content,
    { async: false },
  );
  const galleryHtml = renderUnreferencedAttachments(data);
  const publishedDate = utcDate(article.publishedAt ?? article.createdAt);
  const modifiedDate = utcDate(article.updatedAt);
  const feedUrl = `${origin}/feed.xml`;

  return `<!doctype html>
<html lang="${escapeHtml(htmlLang(article.lang))}" dir="${isRtlLang(article.lang) ? "rtl" : "ltr"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#faf9f7" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0d0c0b" media="(prefers-color-scheme: dark)" />
    ${buildArticleHeadTags(input)}
    <link rel="alternate" type="application/rss+xml" title="${escapeHtml(product)}" href="${escapeHtml(feedUrl)}" />
    <link
      rel="icon"
      href="${escapeHtml(input.faviconUrl ?? "/brand/flaremo-mark-light-300.png")}"
      type="${escapeHtml(input.faviconType ?? "image/png")}"
    />
    <style>${ARTICLE_PAGE_STYLES}</style>
  </head>
  <body>
    <header>
      <a href="${escapeHtml(origin)}/">${escapeHtml(product)}</a>
      <time datetime="${escapeHtml(article.publishedAt ?? article.createdAt)}">${escapeHtml(publishedDate)}</time>
    </header>
    <main>
      <article data-flaremo-article>${bodyHtml}</article>
      ${galleryHtml}
    </main>
    <footer>发布于 ${escapeHtml(publishedDate)} · 更新于 ${escapeHtml(modifiedDate)} · 作者 ${escapeHtml(user.name)} · <a href="${escapeHtml(origin)}">用 ${escapeHtml(product)} 打开</a></footer>
  </body>
</html>`;
}

function renderArticleUnavailableDocument(product: string): string {
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
    <div><strong>${escapeHtml(product)}</strong><p>该文章不存在或尚未发布。</p></div>
  </body>
</html>`;
}

const ARTICLE_RESPONSE_INIT = {
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": ARTICLE_HTML_CACHE_CONTROL,
  },
} as const;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerArticlePage(app: Hono<HonoBindings>): void {
  app.get("/article/:slug", async (c) => {
    const db = getFlareMoDb(c.env);
    let data: ArticlePageData;
    try {
      data = await getPublicArticleBySlug(db, c.req.param("slug"));
    } catch {
      const branding = await getBranding(db).catch(() => null);
      return new Response(
        renderArticleUnavailableDocument(branding?.product ?? "FlareMo"),
        { ...ARTICLE_RESPONSE_INIT, status: 404 },
      );
    }
    const branding = await getBranding(db).catch(() => null);
    try {
      // Loads every supported code-fence language before parsing so the
      // render stays synchronous; failures degrade to plain code blocks.
      await initArticleHighlighter(data.article.content);
    } catch {
      // Highlighter failures degrade to plain code blocks, never 500s.
    }
    const input: ArticleMetaInput = {
      origin: publicOrigin(c.env, c.req.raw),
      product: branding?.product ?? "FlareMo",
      faviconUrl: branding?.favicon
        ? `/api/app/branding/favicon?v=${encodeURIComponent(branding.favicon.updated_at)}`
        : null,
      faviconType: branding?.favicon?.content_type ?? null,
      data,
    };
    return new Response(renderArticleDocument(input), {
      ...ARTICLE_RESPONSE_INIT,
    });
  });

  // The enumerable public surface. Share tokens stay out of sitemaps by
  // design — this endpoint only ever lists published article slugs.
  app.get("/sitemap-articles.xml", async (c) => {
    const db = getFlareMoDb(c.env);
    const origin = publicOrigin(c.env, c.req.raw);
    const rows = await db
      .select({ slug: articles.slug, updatedAt: articles.updatedAt })
      .from(articles)
      .where(
        and(
          eq(articles.status, "published"),
          isNull(articles.deletedAt),
          isNotNull(articles.publishedAt),
        ),
      )
      .orderBy(desc(articles.publishedAt))
      .limit(2000);
    // The package throws EmptySitemap on a zero-entry stream; an instance
    // with no published articles must still answer a valid empty urlset.
    let xml =
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
    if (rows.length > 0) {
      const stream = new SitemapStream({ hostname: `${origin}/` });
      for (const row of rows) {
        stream.write({
          url: `${origin}/article/${encodeURIComponent(row.slug)}`,
          lastmod: row.updatedAt,
        });
      }
      stream.end();
      xml = (await streamToPromise(stream)).toString();
    }
    return new Response(xml, {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": SYNDICATION_CACHE_CONTROL,
      },
    });
  });

  // Full-content RSS: the SSR renderer already produces the article HTML,
  // so syndication carries the rendered body (plain code blocks; feeds are
  // re-rendered without the highlighter to stay cheap).
  app.get("/feed.xml", async (c) => {
    const db = getFlareMoDb(c.env);
    const origin = publicOrigin(c.env, c.req.raw);
    let product = "FlareMo";
    try {
      product = (await getBranding(db)).product;
    } catch {
      // Default branding is fine for a feed.
    }
    const rows = await db
      .select({ article: articles, authorName: users.name })
      .from(articles)
      .innerJoin(users, eq(articles.userId, users.id))
      .where(
        and(
          eq(articles.status, "published"),
          isNull(articles.deletedAt),
          isNotNull(articles.publishedAt),
        ),
      )
      .orderBy(desc(articles.publishedAt))
      .limit(FEED_SIZE);
    const feed = new Feed({
      title: product,
      description: `${product} 发布的文章`,
      id: `${origin}/`,
      link: `${origin}/`,
      // A single feed cannot vary language per item, so follow the newest
      // article's declared language rather than always claiming Chinese.
      language: htmlLang(rows[0]?.article.lang ?? null),
      favicon: `${origin}/brand/flaremo-mark-light-300.png`,
      copyright: `© ${new Date().getFullYear()} ${product}`,
      updated: rows[0]?.article.updatedAt
        ? new Date(rows[0].article.updatedAt)
        : new Date(),
      generator: "FlareMo",
      feedLinks: { rss: `${origin}/feed.xml` },
    });
    for (const { article, authorName } of rows) {
      const canonical = `${origin}/article/${encodeURIComponent(article.slug)}`;
      // Same rewrite as the SSR page, but absolute: relative image URLs do
      // not resolve inside feed readers. The highlighter is skipped here —
      // feeds carry plain code blocks to stay cheap.
      const feedContent = rewriteArticleFileUrls(
        article.content,
        article.slug,
        origin,
      );
      const contentHtml = createSanitizedMarked({}).parse(feedContent, {
        async: false,
      });
      feed.addItem({
        title: article.title || `${product} 文章`,
        id: canonical,
        link: canonical,
        description:
          article.description?.trim() ||
          truncate(contentToPlainText(article.content), 200),
        content: contentHtml,
        date: new Date(article.publishedAt ?? article.createdAt),
        published: new Date(article.publishedAt ?? article.createdAt),
        author: [{ name: authorName }],
      });
    }
    return new Response(feed.rss2(), {
      headers: {
        "content-type": "application/rss+xml; charset=utf-8",
        "cache-control": SYNDICATION_CACHE_CONTROL,
      },
    });
  });
}
