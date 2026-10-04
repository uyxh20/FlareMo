import {
  ArrowRight,
  Database,
  ExternalLink,
  Image as ImageIcon,
  ServerOff,
  ShieldCheck,
} from "lucide-react";
import {
  AnimatedNumber,
  PopIn,
  Reveal,
  RevealGroup,
  RevealItem,
} from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { STAT_TITLES } from "@/content/comparison-i18n";
import type { HomeContent } from "@/content/copy";
import { getLocalizedPath, type SupportedLocale } from "@/lib/seo";
/* ============================================================
   1. Hero 区块
   ============================================================ */

export function Hero({
  locale,
  home,
}: {
  locale: SupportedLocale;
  home: HomeContent;
}) {
  const titles = STAT_TITLES[locale] || STAT_TITLES.en;

  return (
    <section className="relative pt-12 md:pt-20">
      <div className="container-x space-y-12">
        {/* 限宽交给各子元素（副标题自带 mx-auto max-w-2xl）；外层不能限宽——
            EN/ZH 标题锁行 nowrap 后行宽会超过 3xl，行盒溢出会导致 text-center 失效 */}
        <div className="space-y-6 text-center">
          {/* Eyebrow Pill */}
          <PopIn className="inline-flex">
            <div className="inline-flex items-center gap-2 rounded-full border border-signal/30 bg-signal/10 px-3.5 py-1 text-xs font-semibold text-signal-ink shadow-2xs backdrop-blur-md">
              <span>{home.heroEyebrow}</span>
            </div>
          </PopIn>

          {/* Headline */}
          <Reveal delay={0.08}>
            <h1 className="text-[clamp(1.75rem,5.2vw,4.25rem)] font-extrabold tracking-tight text-ink leading-[1.14]">
              {/* nowrap 仅对允许整行展示的语言生效（CJK/拉丁）；阿语等长词换行语言不锁行 */}
              <span
                className={`block${locale === "en" || locale === "zh" ? " sm:whitespace-nowrap" : ""}`}
              >
                {home.heroTitleLine1}
              </span>
              <span
                className={`mt-1.5 block sm:mt-2.5 text-brand-gradient${locale === "en" || locale === "zh" ? " sm:whitespace-nowrap" : ""}`}
              >
                {home.heroTitleLine2}
              </span>
            </h1>
          </Reveal>

          {/* Subtitle */}
          <Reveal delay={0.16}>
            <p className="mx-auto max-w-2xl text-pretty text-base text-mist sm:text-lg leading-relaxed">
              {home.heroSubtitle}
            </p>
          </Reveal>

          {/* Actions */}
          <Reveal delay={0.24}>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <Button
                render={<a href={getLocalizedPath("/docs/deploy", locale)} />}
                size="lg"
                variant="flame"
                className="shadow-pop"
              >
                <span>{home.primaryCta}</span>
                <ArrowRight className="size-4 rtl:-rotate-180" />
              </Button>

              <Button
                render={
                  <a
                    href="https://github.com/realchendahuang/FlareMo"
                    rel="noopener noreferrer"
                    target="_blank"
                  />
                }
                size="lg"
                variant="secondary"
              >
                <span>{home.secondaryCta}</span>
                <ExternalLink className="size-3.5 text-mist" />
              </Button>
            </div>
          </Reveal>
        </div>

        {/* 4 栏核心指标看板 */}
        <RevealGroup
          stagger={0.08}
          className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
        >
          <RevealItem>
            <SpotlightCard className="p-5 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <div className="icon-dock flex size-9 items-center justify-center text-signal">
                  <Database className="size-4" />
                </div>
                <Badge variant="flame">D1 Storage</Badge>
              </div>
              <div className="mt-4">
                <div className="text-3xl font-extrabold tracking-tight tabular-nums text-ink">
                  <AnimatedNumber value={5} suffix=" GB" locale={locale} />
                </div>
                <div className="mt-1 text-xs text-mist">{home.statMemos}</div>
              </div>
            </SpotlightCard>
          </RevealItem>

          <RevealItem>
            <SpotlightCard className="p-5 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <div className="icon-dock flex size-9 items-center justify-center text-signal">
                  <ImageIcon className="size-4" />
                </div>
                <Badge variant="flame">R2 Free Egress</Badge>
              </div>
              <div className="mt-4">
                <div className="text-3xl font-extrabold tracking-tight tabular-nums text-ink">
                  <AnimatedNumber value={10} suffix=" GB" locale={locale} />
                </div>
                <div className="mt-1 text-xs text-mist">{home.statPhotos}</div>
              </div>
            </SpotlightCard>
          </RevealItem>

          <RevealItem>
            <SpotlightCard className="p-5 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <div className="icon-dock flex size-9 items-center justify-center text-signal">
                  <ServerOff className="size-4" />
                </div>
                <Badge variant="secondary">Zero Ops</Badge>
              </div>
              <div className="mt-4">
                <div className="text-3xl font-extrabold tracking-tight tabular-nums text-ink">
                  {titles.servers}
                </div>
                <div className="mt-1 text-xs text-mist">{home.statServers}</div>
              </div>
            </SpotlightCard>
          </RevealItem>

          <RevealItem>
            <SpotlightCard className="p-5 flex flex-col justify-between h-full">
              <div className="flex items-center justify-between">
                <div className="icon-dock flex size-9 items-center justify-center text-signal">
                  <ShieldCheck className="size-4" />
                </div>
                <Badge variant="success">Your Data</Badge>
              </div>
              <div className="mt-4">
                <div className="text-3xl font-extrabold tracking-tight tabular-nums text-ink">
                  {titles.ownership}
                </div>
                <div className="mt-1 text-xs text-mist">{home.statUptime}</div>
              </div>
            </SpotlightCard>
          </RevealItem>
        </RevealGroup>
      </div>
    </section>
  );
}
