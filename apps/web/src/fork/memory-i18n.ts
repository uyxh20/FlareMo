import { useCallback, useMemo } from "react";
import type { TranslationKey } from "@/i18n";
import { useI18n } from "@/i18n";
import {
  type ForkMemoryMessageKey,
  forkMemoryMessages,
} from "./memory-messages";

// Fork-owned (docs/fork-customizations.md). The Memory page's `t`: the page's
// own strings (gone from upstream's catalogs since v0.27) come from
// memory-messages.ts, everything else from upstream's catalog.

type Params = Record<string, string | number>;
export type ForkMemoryKey = TranslationKey | ForkMemoryMessageKey;

function interpolate(template: string, params?: Params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    String(params[key] ?? match),
  );
}

export function useForkMemoryI18n() {
  const i18n = useI18n();
  const upstreamT = i18n.t;
  const t = useCallback(
    (key: ForkMemoryKey, params?: Params) =>
      key in forkMemoryMessages
        ? interpolate(forkMemoryMessages[key as ForkMemoryMessageKey], params)
        : upstreamT(key as TranslationKey, params),
    [upstreamT],
  );
  return useMemo(() => ({ ...i18n, t }), [i18n, t]);
}
