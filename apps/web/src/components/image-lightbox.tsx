import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  DownloadIcon,
  RotateCcwIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** One wheel notch / zoom-button step. */
const SCALE_STEP = 0.25;

type ImageLightboxProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src?: string;
  alt?: string;
  downloadUrl?: string;
  filename?: string;
};

/**
 * Full-surface image preview. The image renders at its intrinsic width inside
 * a scrollable viewport, so a tall screenshot stays fully readable by
 * scrolling instead of being shrunk into an 85vh box. Wheel zoom (ctrl-free,
 * plain wheel scales like a viewer) grows beyond the viewport and the
 * horizontal overflow pans; Reset returns to the fit view.
 */
export function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
  downloadUrl,
  filename,
}: ImageLightboxProps) {
  const { t } = useI18n();
  const [scale, setScale] = useState(MIN_SCALE);
  // Set once the img loads; lets the viewport give the scrollable content the
  // intrinsic height before the bytes arrive (no scrollbar jump mid-load).
  const [intrinsic, setIntrinsic] = useState<{ w: number; h: number } | null>(
    null,
  );
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setScale(MIN_SCALE);
      setIntrinsic(null);
    }
  }, [open]);

  const zoomTo = useCallback((next: number) => {
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.deltaY) return;
    event.preventDefault();
    setScale((current) => {
      const next =
        current * (event.deltaY < 0 ? 1 + SCALE_STEP : 1 / (1 + SCALE_STEP));
      return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    });
  }, []);

  if (!src) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md transition-opacity duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className="fixed inset-0 z-50 flex flex-col p-4 outline-none select-none"
          initialFocus={viewportRef}
        >
          {/* Top action bar */}
          <div className="relative z-10 flex items-center justify-between">
            <span className="truncate max-w-[50vw] text-xs font-mono text-white/70">
              {filename ?? alt ?? ""}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("imageViewer.zoomOut")}
                title={t("imageViewer.zoomOut")}
                disabled={scale <= MIN_SCALE}
                className="size-8 text-white/90 hover:bg-white/20 hover:text-white"
                onClick={() => zoomTo(scale - SCALE_STEP)}
              >
                <ZoomOutIcon className="size-4" />
              </Button>
              <span className="min-w-10 text-center font-mono text-xs text-white/70">
                {Math.round(scale * 100)}%
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("imageViewer.zoomIn")}
                title={t("imageViewer.zoomIn")}
                disabled={scale >= MAX_SCALE}
                className="size-8 text-white/90 hover:bg-white/20 hover:text-white"
                onClick={() => zoomTo(scale + SCALE_STEP)}
              >
                <ZoomInIcon className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("imageViewer.reset")}
                title={t("imageViewer.reset")}
                disabled={scale === MIN_SCALE}
                className="size-8 text-white/90 hover:bg-white/20 hover:text-white"
                onClick={() => zoomTo(MIN_SCALE)}
              >
                <RotateCcwIcon className="size-4" />
              </Button>
              {downloadUrl && (
                <a
                  href={downloadUrl}
                  download={filename}
                  aria-label={t("common.download")}
                  title={t("common.download")}
                  className="inline-flex size-8 items-center justify-center rounded-lg bg-white/10 text-white/90 hover:bg-white/20 transition-colors"
                >
                  <DownloadIcon className="size-4" />
                </a>
              )}
              <DialogPrimitive.Close
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("common.close")}
                    title={t("common.close")}
                    className="size-8 text-white/90 hover:bg-white/20 hover:text-white"
                  >
                    <XIcon className="size-4" />
                  </Button>
                }
              />
            </div>
          </div>

          {/* Scrollable viewport: fit-width by default (scale 1), wheel/button
              zoom scales the intrinsic box; horizontal overflow pans with
              native scroll. */}
          <div
            className="mt-2 flex-1 overflow-auto rounded-lg"
            onWheel={handleWheel}
            ref={viewportRef}
          >
            <img
              src={src}
              alt={alt ?? filename ?? ""}
              className="mx-auto block rounded-lg shadow-2xl"
              decoding="async"
              onLoad={(event) => {
                const img = event.currentTarget;
                if (img.naturalWidth) {
                  setIntrinsic({ w: img.naturalWidth, h: img.naturalHeight });
                }
              }}
              style={
                intrinsic
                  ? {
                      // Base width fills the viewport; scale multiplies it.
                      // The intrinsic ratio is preserved by the browser.
                      width: `${scale * 100}%`,
                      maxWidth: "none",
                      minWidth: `${intrinsic.w}px`,
                    }
                  : { maxWidth: "none", minWidth: "0px" }
              }
            />
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
