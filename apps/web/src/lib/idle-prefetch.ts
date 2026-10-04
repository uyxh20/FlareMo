/**
 * Warm a lazily-imported chunk while the browser is idle.
 *
 * The composer's rich editor is ~160KB gzipped and the focus canvas ~35KB.
 * Both are pre-warmed on idle so a first tap into the composer costs nothing,
 * but a prefetch is still a download: when the visitor asked to save data
 * (`navigator.connection.saveData`) or is on a 2G-class link, the bytes are
 * worth more than the few hundred milliseconds they'd save. The on-demand
 * import runs regardless, so nothing depends on the prefetch having happened.
 */
export function prefetchWhenIdle(load: () => Promise<unknown>) {
  if (typeof window === "undefined") return;
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (connection?.saveData) return;
  if (connection?.effectiveType && /(^|-)2g$/.test(connection.effectiveType)) {
    return;
  }
  const warm = () => {
    void load().catch(() => undefined);
  };
  const idle = (
    window as Window & {
      requestIdleCallback?: (callback: () => void) => number;
    }
  ).requestIdleCallback;
  if (idle) idle(warm);
  else setTimeout(warm, 2000);
}
