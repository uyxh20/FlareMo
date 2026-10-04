import {
  Link,
  useLoaderData,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { ChevronDown, ChevronLeft } from "lucide-react";
import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { docPath, getDocNavGroups } from "@/content/docs-nav";
import {
  type DocEntry,
  type DocMeta,
  listDocs,
} from "@/lib/docs-source.generated";
import {
  getLocaleFromPath,
  getLocalizedPath,
  type SupportedLocale,
} from "@/lib/seo";

const markdownComponents: Components = {
  // A non-leading H1 is still meaningful content; keep it as a heading while
  // avoiding a second level-one heading when a document repeats its title.
  h1: ({ children }) => <h2>{children}</h2>,
  table: ({ children }) => (
    <div className="prose-table-scroll">
      <table>{children}</table>
    </div>
  ),
};

function removeDuplicateLeadingTitle(markdown: string, title: string) {
  const lines = markdown.split(/\r?\n/);
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine < 0) return markdown;

  const firstLine = lines[firstContentLine];
  if (!/^#(?!#)\s+/.test(firstLine)) return markdown;

  const heading = firstLine
    .replace(/^#\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
  if (heading !== title.trim()) return markdown;

  lines.splice(firstContentLine, 1);
  return lines.join("\n");
}

function DocsNav({
  allDocs,
  groups,
  locale,
  slug,
}: {
  allDocs: DocMeta[];
  groups: ReturnType<typeof getDocNavGroups>;
  locale: SupportedLocale;
  slug: string;
}) {
  return (
    <nav
      aria-label={locale === "zh" ? "文档目录" : "Documentation"}
      className="space-y-5"
    >
      {groups.map((group) => {
        const docsInGroup = allDocs.filter((d) => d.group === group.id);
        if (docsInGroup.length === 0) return null;
        return (
          <div key={group.id} className="space-y-1.5">
            <div className="px-2 text-xs font-bold uppercase tracking-wider text-fog">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {docsInGroup.map((d) => {
                const isActive = d.slug === slug;
                return (
                  <li key={d.slug}>
                    <Link
                      className={`block rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                        isActive
                          ? "border border-line/60 bg-surface font-bold text-signal-ink shadow-2xs"
                          : "text-mist hover:bg-wash hover:text-ink"
                      }`}
                      to={docPath(d.slug, locale)}
                    >
                      {d.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function DocsDetailPage() {
  const { pathname } = useLocation();
  const { slug: routeSlug } = useParams({ strict: false }) as { slug?: string };
  const locale = getLocaleFromPath(pathname);
  const docLocale = locale === "zh" ? "zh-CN" : "en-US";
  const slug = routeSlug ?? "";

  const { doc } = useLoaderData({ strict: false }) as {
    doc: DocEntry | null;
  };
  const allDocs = useMemo(() => listDocs(docLocale), [docLocale]);
  const groups = useMemo(() => getDocNavGroups(locale), [locale]);
  const markdownBody = useMemo(
    () => (doc ? removeDuplicateLeadingTitle(doc.body, doc.title) : ""),
    [doc],
  );

  if (!doc) {
    return (
      <div className="container-x py-20 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {locale === "zh" ? "文档不存在" : "Document not found"}
        </h1>
        <p className="mt-2 text-sm text-mist">
          {locale === "zh"
            ? "我们暂时没有这份文档。请查看文档总览。"
            : "We don't have that document. See the docs index."}
        </p>
        <Link
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-signal hover:underline"
          to={getLocalizedPath("/docs", locale)}
        >
          <ChevronLeft className="size-4 rtl:-rotate-180" />
          {locale === "zh" ? "回到文档总览" : "Back to docs"}
        </Link>
      </div>
    );
  }

  return (
    <div className="container-x grid gap-10 py-10 md:py-14 lg:grid-cols-[15rem_1fr]">
      {/* 侧边导航栏 */}
      <aside className="lg:sticky lg:top-20 lg:self-start space-y-6">
        <Link
          className="inline-flex items-center gap-1 text-xs font-semibold text-mist hover:text-ink transition-colors"
          to={getLocalizedPath("/docs", locale)}
        >
          <ChevronLeft className="size-3.5 rtl:-rotate-180" />
          <span>{locale === "zh" ? "文档总览" : "Docs Overview"}</span>
        </Link>

        <details
          className="group rounded-xl border border-line/60 bg-soft-surface/40 lg:hidden"
          key={`${locale}:${slug}`}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
            <span>{locale === "zh" ? "文档目录" : "Documentation"}</span>
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-line/60 px-3 pb-3 pt-3">
            <DocsNav
              allDocs={allDocs}
              groups={groups}
              locale={locale}
              slug={slug}
            />
          </div>
        </details>

        <div className="hidden lg:block">
          <DocsNav
            allDocs={allDocs}
            groups={groups}
            locale={locale}
            slug={slug}
          />
        </div>
      </aside>

      {/* 文档主体内容。
          正文只有中文原文与英文两个来源，而页面 <html lang> 跟随界面语言
          （ja/ko/fr/…）。把正文自身的语言标出来，字形与读屏才按内容走：
          中文原文用中文字形，英文译文用拉丁字形——否则日/韩/阿语页面上的
          英文正文会被 Han 字体族接管，中文原文又会被日韩字面重塑。 */}
      <article
        className="min-w-0"
        lang={locale === "zh" || doc.fallbackFromZh ? "zh-CN" : "en-US"}
      >
        {doc.fallbackFromZh ? (
          <div className="mb-6 rounded-xl border border-signal/30 bg-signal/10 px-4 py-3 text-sm text-signal-ink">
            {locale === "zh"
              ? "本页内容为中文原文；尚未翻译为英文。"
              : "This document is shown in its original Chinese; an English translation is pending."}
          </div>
        ) : null}

        <header className="mb-8 space-y-2 border-b border-line/60 pb-6">
          <div className="text-xs font-bold uppercase tracking-wider text-signal">
            {groups.find((g) => g.id === doc.group)?.label}
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
            {doc.title}
          </h1>
        </header>

        <div className="prose-doc">
          <ReactMarkdown
            components={markdownComponents}
            remarkPlugins={[remarkGfm]}
          >
            {markdownBody}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
}
