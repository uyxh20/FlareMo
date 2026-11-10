import type { PlannerOverdueResponse } from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircleIcon } from "lucide-react";
import { apiRequest } from "@/api/client";
import { useI18n } from "@/i18n";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerToday } from "./use-planner-clock";

// The sidebar's task reminders, pointed at the cockpit (fork-owned add-on,
// docs/fork-customizations.md "Overdue reminder opens the cockpit"). It stands in
// for upstream's MiniCalendarReminders (components/flaremo-mini-calendar-panel.tsx),
// which flaremo-explorer.tsx no longer renders: that one counted only the first
// 100 tasks, only within this month, and opened the hidden /projects page.
//
// This one asks the server for two counts (GET /api/app/planner/overdue) and
// opens /cockpit. Overdue means what the cockpit's red due chip means: open, not
// dropped, due before today, from any month. It looks exactly like upstream's.
// The count is a cockpit query, so a change on the board refreshes it.

const overdueLabels = {
  en: (count: number) => `${count} overdue`,
  zhCN: (count: number) => `已逾期 ${count} 件`,
} as const;

/** The overdue line's words: Chinese for zh-CN, English otherwise. */
export function plannerOverdueLabelFor(locale: string, count: number): string {
  return locale === "zh-CN"
    ? overdueLabels.zhCN(count)
    : overdueLabels.en(count);
}

export function plannerFetchOverdue(today: string) {
  const query = new URLSearchParams({ today });
  return apiRequest<PlannerOverdueResponse>(
    `/api/app/planner/overdue?${query}`,
  );
}

export function PlannerOverdueReminders() {
  const { locale, t } = useI18n();
  const today = usePlannerToday();
  const counts = useQuery({
    queryKey: plannerQueryKeys.overdue(today),
    queryFn: () => plannerFetchOverdue(today),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const dueToday = counts.data?.due_today ?? 0;
  const overdue = counts.data?.overdue ?? 0;

  if (dueToday <= 0 && overdue <= 0) return null;
  return (
    <>
      {dueToday > 0 && (
        <Link
          className="mb-1.5 flex items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-brand-700 dark:text-brand-200 bg-brand-100 dark:bg-brand-400/12 motion-safe:transition-colors motion-safe:duration-150 hover:bg-brand-100/80 dark:hover:bg-brand-400/20 focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="mini-calendar-today-notice"
          to="/cockpit"
        >
          <AlertCircleIcon className="shrink-0" />
          {t("calendar.overdueToday", { count: dueToday })}
        </Link>
      )}
      {overdue > 0 && (
        <Link
          className="mb-1 block px-1 text-xs text-destructive underline-offset-2 hover:underline"
          data-testid="planner-overdue-link"
          to="/cockpit"
        >
          {plannerOverdueLabelFor(locale, overdue)}
        </Link>
      )}
    </>
  );
}
