import { CheckIcon, Minimize2Icon } from "lucide-react";
import type { ComposerPublishType } from "@/components/composer/composer-type-menu";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n";

/**
 * Top bar of the focus canvas: the sr-only dialog title, the local-save
 * status with live word count / reading time, and the ESC + minimize
 * affordances that exit back to the inline composer.
 */
export function ComposerCanvasHeader({
  publishType,
  charCount,
  readingTimeMinutes,
}: {
  publishType: ComposerPublishType;
  charCount: number;
  readingTimeMinutes: number;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/40 px-4 sm:px-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <DialogTitle className="sr-only">
          {publishType === "article"
            ? t("composer.type.article")
            : t("composer.type.memo")}
        </DialogTitle>
        <div className="flex items-center gap-1.5 text-muted-foreground/80">
          <CheckIcon className="size-3 text-brand-600 dark:text-brand-400" />
          <span>{t("composer.fullscreen.savedLocally")}</span>
        </div>
        {charCount > 0 && (
          <>
            <span className="text-border/60">·</span>
            <span className="tabular-nums">
              {t("composer.fullscreen.wordCount", { count: charCount })}
            </span>
            {charCount >= 200 && (
              <>
                <span className="text-border/60">·</span>
                <span>
                  {t("composer.fullscreen.readingTime", {
                    minutes: readingTimeMinutes,
                  })}
                </span>
              </>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <kbd className="hidden font-mono text-[10px] text-muted-foreground/70 sm:inline-flex items-center rounded border border-border/60 bg-muted/60 px-1.5 py-0.5">
          ESC
        </kbd>
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              title={t("composer.fullscreen.close")}
              aria-label={t("composer.fullscreen.close")}
            />
          }
        >
          <Minimize2Icon className="size-4" />
        </DialogClose>
      </div>
    </div>
  );
}
