import { lazy } from "react";
import { prefetchWhenIdle } from "@/lib/idle-prefetch";

/**
 * The fullscreen focus canvas is ~35KB and pre-warmed while the browser is
 * idle. By the time the user reaches for the full screen icon, the chunk is
 * already local, so entering full screen is instantaneous. The warm-up is
 * skipped on metered connections (see `prefetchWhenIdle`).
 */
const focusCanvasLoader = () =>
  import("@/components/composer/composer-focus-canvas");

export function loadComposerFocusCanvas() {
  return focusCanvasLoader();
}

export const ComposerFocusCanvas = lazy(async () => {
  const module = await focusCanvasLoader();
  return { default: module.ComposerFocusCanvas };
});

prefetchWhenIdle(focusCanvasLoader);
