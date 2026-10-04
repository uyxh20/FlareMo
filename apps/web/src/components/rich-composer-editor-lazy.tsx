import { lazy } from "react";
import { prefetchWhenIdle } from "@/lib/idle-prefetch";

/**
 * The TipTap editor is ~140KB gzipped and never needed before the user starts
 * writing, so it ships as its own async chunk instead of the startup bundle.
 * `prefetchWhenIdle` warms it right after load: by the time the user reaches
 * for the composer the chunk is already local, so lazy loading costs nothing
 * in practice. On a metered or 2G connection the warm-up is skipped and only
 * the real, on-demand import pays for it.
 */
export function loadRichComposerEditor() {
  return import("@/components/rich-composer-editor");
}

export const RichComposerEditor = lazy(async () => {
  const module = await loadRichComposerEditor();
  return { default: module.RichComposerEditor };
});

prefetchWhenIdle(loadRichComposerEditor);
