import { useRouter } from "@tanstack/react-router";
import { Check, ChevronDown, Globe } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getLocalizedPath,
  LOCALE_LABELS,
  type Locale,
  normalizeLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@/lib/seo";
import { cn } from "@/lib/utils";

const LOCALE_SHORT_LABELS: Record<SupportedLocale, string> = {
  zh: "中文",
  en: "EN",
  ja: "日本語",
  fr: "FR",
  es: "ES",
  ko: "한국어",
  ru: "RU",
  ar: "العربية",
};

type LocaleSwitcherProps = {
  locale: Locale;
  /** Path of the current route (e.g. "/", "/docs", "/docs/deploy"). */
  path: string;
  className?: string;
  short?: boolean;
};

export function LocaleSwitcher({
  locale,
  path,
  className,
  short = false,
}: LocaleSwitcherProps) {
  const router = useRouter();
  const current = normalizeLocale(locale);

  const handleSelect = (next: SupportedLocale) => {
    if (next === current) return;
    const nextHref = getLocalizedPath(path, next);
    try {
      void router.navigate({ to: nextHref as string });
    } catch {
      window.location.href = nextHref;
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        aria-label="选择语言 / Select language"
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border border-line/70 bg-surface/90 px-2.5 text-xs font-medium text-ink shadow-2xs transition-colors hover:bg-wash hover:border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 focus-visible:ring-offset-2 focus-visible:ring-offset-paper cursor-pointer",
          className,
        )}
      >
        <Globe className="size-3.5 text-mist shrink-0" />
        <span className="truncate">
          {short ? LOCALE_SHORT_LABELS[current] : LOCALE_LABELS[current]}
        </span>
        <ChevronDown className="size-3 text-fog shrink-0 opacity-70" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-44 p-1.5">
        <DropdownMenuLabel className="px-2 py-1 text-xs text-fog font-medium">
          语言 / Language
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SUPPORTED_LOCALES.map((loc) => {
          const isSelected = loc === current;
          return (
            <DropdownMenuItem
              key={loc}
              onClick={() => handleSelect(loc)}
              className="flex items-center justify-between px-2.5 py-1.5 text-xs cursor-pointer rounded-lg hover:bg-wash focus:bg-wash"
            >
              <span
                className={
                  isSelected ? "font-bold text-signal-ink" : "text-ink"
                }
              >
                {LOCALE_LABELS[loc]}
              </span>
              {isSelected && (
                <Check className="size-3.5 text-signal shrink-0" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
