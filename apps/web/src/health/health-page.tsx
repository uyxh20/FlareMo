import {
  type HealthEntryDto,
  type HealthEntryKind,
  type HealthFamily,
  type HealthYearResponse,
  healthAddDays,
  healthDaysBetween,
  healthLocalMoment,
} from "@flaremo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulseIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { QueryErrorState } from "@/components/query-error-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { WorkspacePageHeader } from "@/components/workspace/workspace-page-header";
import { cn } from "@/lib/utils";
import {
  healthFetchYear,
  healthPatchEntryRequest,
  healthRescanRequest,
} from "./api";
import {
  type HealthBreakdown,
  HealthBreakdownDialog,
} from "./breakdown-dialog";
import { HealthHomeAnswers } from "./memo-labels";
import {
  type HealthFamilyRow,
  type HealthYearWeek,
  healthBreakdownOfDays,
  healthBreakdownOfEntries,
  healthDayShort,
  healthFamilyDays,
  healthFamilyRows,
  healthFormatUnits,
  healthLevel,
  healthMonthMarks,
  healthWeekdayShort,
  healthYearWeeks,
} from "./model";
import { healthQueryKeys } from "./query-keys";
import { HealthSinceStrip } from "./since-strip";
import { healthStrings } from "./strings";
import { useHealthThisWeek } from "./this-week";
import { useHealthTrackers } from "./trackers";
import { HealthTrackersPanel } from "./trackers-panel";
import "./health.css";

// The Health page at /health (fork-owned add-on, docs/fork-health-tracker.md):
// what happened this week (counts, no targets), the nights out so far this year
// with a strip of the days since the last one,
// the nights still waiting for a home time, and the year week by week. A button
// reads the whole diary again. Same WorkspaceLayout and WorkspacePageHeader as
// the cockpit.

const s = healthStrings.page;

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 motion-safe:animate-rise">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Tile({
  kind,
  kindClass = `health-kind-${kind}`,
  title,
  big,
  note,
  onOpen,
}: {
  kind: HealthEntryKind | HealthFamily;
  kindClass?: string;
  title: string;
  big: string;
  note: string;
  onOpen: () => void;
}) {
  return (
    <button
      aria-label={healthStrings.breakdown.open(title)}
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border/50 bg-card/60 p-4 text-left outline-none hover:border-border focus-visible:ring-2 focus-visible:ring-ring/50",
        kindClass,
      )}
      data-kind={kind}
      data-testid="health-tile"
      type="button"
      onClick={onOpen}
    >
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-3xl font-semibold tabular-nums"
          style={{ color: "var(--k-ink)" }}
        >
          {big}
        </span>
      </div>
      <span className="truncate text-xs text-muted-foreground">{note}</span>
    </button>
  );
}

function WeekSection() {
  const trackers = useHealthTrackers().data?.trackers;
  const query = useHealthThisWeek();
  const [open, setOpen] = useState<HealthBreakdown | null>(null);
  if (query.isError) {
    return (
      <QueryErrorState
        className="min-h-40 text-muted-foreground"
        isRetrying={query.isRefetching}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <Skeleton className="h-36 rounded-xl" />;
  const { start, end, summary, entries } = query.data;
  const breakdownOf = (row: HealthFamilyRow) =>
    healthBreakdownOfEntries(entries, row.family, trackers);
  const subtypeNote = (row: HealthFamilyRow) =>
    breakdownOf(row)
      .map((item) => `${item.label} ${item.count}`)
      .join(" · ");
  const noteOf = (row: HealthFamilyRow): string => {
    const days = healthFamilyDays(entries, row.family);
    if (row.family === "fitness") {
      return days === 0 ? s.fitnessNone : subtypeNote(row);
    }
    if (row.family === "breath") {
      return days === 0
        ? s.breathNote(0, 0)
        : `${subtypeNote(row)}${summary.breath.minutes > 0 ? ` · ${summary.breath.minutes} min` : ""}`;
    }
    if (row.family === "night_out") {
      return s.outNote(healthFormatUnits(summary.night_out.units));
    }
    const tracker = trackers?.find((item) => item.kind === row.family);
    const count = query.data.trackers.find((item) => item.kind === row.family);
    const minutes = count?.minutes ?? 0;
    const sub = tracker?.subtypes.length ? subtypeNote(row) : "";
    const length =
      minutes > 0 && tracker?.measure === "hours"
        ? healthStrings.trackers.weekHours(minutes)
        : minutes > 0 && tracker?.measure === "minutes"
          ? healthStrings.trackers.weekMinutes(minutes)
          : healthStrings.trackers.weekNote(count?.days ?? 0);
    return [sub, length].filter(Boolean).join(" · ");
  };
  return (
    <Section
      hint={s.weekRange(healthDayShort(start), healthDayShort(end))}
      title={s.thisWeek}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {healthFamilyRows(trackers).map((row) => {
          const days = healthFamilyDays(entries, row.family);
          return (
            <Tile
              big={
                row.family === "night_out"
                  ? healthFormatUnits(summary.night_out.units)
                  : String(days)
              }
              key={row.family}
              kind={row.family}
              kindClass={row.kindClass}
              note={noteOf(row)}
              title={row.label}
              onOpen={() =>
                setOpen({
                  title: healthStrings.breakdown.week(row.label),
                  kindClass: row.kindClass,
                  totalLabel:
                    row.family === "night_out"
                      ? healthStrings.breakdown.nights
                      : healthStrings.breakdown.days,
                  total: days,
                  rows: breakdownOf(row),
                })
              }
            />
          );
        })}
      </div>
      <HealthBreakdownDialog breakdown={open} onClose={() => setOpen(null)} />
    </Section>
  );
}

function NeedsCheck({
  entries,
  year,
}: {
  entries: readonly HealthEntryDto[];
  year: number;
}) {
  const queryClient = useQueryClient();
  const answer = useMutation({
    mutationFn: (input: { id: string; homeAt: string }) =>
      healthPatchEntryRequest(input.id, { home_at: input.homeAt }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: healthQueryKeys.year(year),
      });
      void queryClient.invalidateQueries({ queryKey: healthQueryKeys.weekAll });
      void queryClient.invalidateQueries({ queryKey: healthQueryKeys.memoAll });
    },
    onError: () => toast.error(healthStrings.chip.failed),
  });
  if (entries.length === 0) return null;
  return (
    <Section hint={s.needsHint} title={s.needsTitle}>
      <ul className="flex flex-col gap-2" data-testid="health-needs-check">
        {entries.map((entry) => (
          <li
            className="health-kind-night_out flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-dashed border-border bg-card/40 px-3.5 py-2.5"
            key={entry.id}
          >
            <span className="min-w-24 text-sm font-medium">
              {healthWeekdayShort(entry.day)} {healthDayShort(entry.day)}
            </span>
            <HealthHomeAnswers
              busy={answer.isPending}
              onAnswer={(homeAt) => answer.mutate({ id: entry.id, homeAt })}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** A full week for a row's darkest cell: Fitness 3 days, Out 2 units, else 7 days. */
function fullWeek(family: HealthFamily): number {
  return family === "fitness" ? 3 : family === "night_out" ? 2 : 7;
}

function weekValue(week: HealthYearWeek, family: HealthFamily): number {
  if (family === "fitness") return week.fitness;
  if (family === "breath") return week.breath;
  if (family === "night_out") return week.out;
  return week.trackers[family] ?? 0;
}

function YearGrid({
  year,
  today,
  days,
}: {
  year: number;
  today: string;
  days: HealthYearResponse["days"];
}) {
  const trackers = useHealthTrackers().data?.trackers;
  const [open, setOpen] = useState<HealthBreakdown | null>(null);
  const weeks = healthYearWeeks(year, days, today);
  const marks = healthMonthMarks(weeks);
  const columns = `repeat(${weeks.length}, minmax(0.875rem, 1fr))`;
  const show = (
    row: HealthFamilyRow,
    title: string,
    range: { from: string; to: string },
  ) => {
    const split = healthBreakdownOfDays(days, row.family, range, trackers);
    setOpen({
      title,
      kindClass: row.kindClass,
      totalLabel:
        row.family === "night_out"
          ? healthStrings.breakdown.nights
          : healthStrings.breakdown.days,
      total: split.days,
      rows: split.rows,
    });
  };
  return (
    <div className="overflow-x-auto pb-1" data-testid="health-year-grid">
      <div className="flex min-w-[44rem] flex-col gap-1.5">
        <div
          aria-hidden="true"
          className="grid gap-[3px] pl-[4.5rem] text-xs text-muted-foreground"
          style={{ gridTemplateColumns: columns }}
        >
          {weeks.map((week, index) => {
            const mark = marks.find((m) => m.index === index);
            return (
              <span className="relative h-4" key={week.start}>
                {mark && (
                  <span className="absolute left-0 whitespace-nowrap">
                    {mark.label}
                  </span>
                )}
              </span>
            );
          })}
        </div>
        {healthFamilyRows(trackers).map((row) => {
          const label = row.label;
          return (
            <div
              className={cn("flex items-center gap-2", row.kindClass)}
              data-family={row.family}
              key={row.family}
            >
              <button
                aria-label={healthStrings.breakdown.open(label)}
                className="w-16 shrink-0 truncate rounded text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                data-testid="health-grid-name"
                type="button"
                onClick={() =>
                  show(row, healthStrings.breakdown.year(label, year), {
                    from: `${year}-01-01`,
                    to: `${year}-12-31`,
                  })
                }
              >
                {label}
              </button>
              <div
                aria-label={s.gridLabel(label)}
                className="grid flex-1 gap-[3px]"
                role="img"
                style={{ gridTemplateColumns: columns }}
              >
                {weeks.map((week) => {
                  const value = weekValue(week, row.family);
                  const text =
                    row.family === "night_out"
                      ? s.units(healthFormatUnits(value))
                      : s.days(value);
                  return (
                    <button
                      aria-label={
                        week.future
                          ? undefined
                          : s.cell(label, healthDayShort(week.start), text)
                      }
                      className="health-cell aspect-square outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
                      data-future={week.future}
                      data-level={healthLevel(value, fullWeek(row.family))}
                      disabled={week.future}
                      key={week.start}
                      title={
                        week.future
                          ? undefined
                          : s.cell(label, healthDayShort(week.start), text)
                      }
                      type="button"
                      onClick={() =>
                        show(
                          row,
                          healthStrings.breakdown.weekOf(
                            label,
                            healthDayShort(week.start),
                          ),
                          {
                            from: week.start,
                            to: healthAddDays(week.start, 6),
                          },
                        )
                      }
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <HealthBreakdownDialog breakdown={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function YearSections({ year }: { year: number }) {
  const query = useQuery({
    queryKey: healthQueryKeys.year(year),
    queryFn: () => healthFetchYear(year),
    staleTime: 30_000,
    retry: false,
  });
  if (query.isError) {
    return (
      <QueryErrorState
        className="min-h-40 text-muted-foreground"
        isRetrying={query.isRefetching}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) {
    return (
      <>
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </>
    );
  }
  const data = query.data;
  const out = data.night_out;
  // Only for the current year: an old year's "days since" means nothing.
  const sinceDays =
    out.last_day && data.year === Number(data.today.slice(0, 4))
      ? healthDaysBetween(out.last_day, data.today)
      : null;
  const empty =
    data.days.length === 0 &&
    data.totals.training === 0 &&
    data.totals.breath_days === 0;
  return (
    <>
      <Section title={s.budgetTitle(data.year)}>
        <div
          className="flex flex-col gap-3 rounded-xl border border-border/50 bg-card/60 p-4"
          data-testid="health-budget"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums">
                {out.nights}
              </span>
              <span className="text-sm">{s.nightsSoFar(out.nights)}</span>
            </div>
            {sinceDays !== null &&
              (sinceDays === 0 ? (
                <p className="text-sm" data-testid="health-since-last">
                  {s.sinceLast(0)}
                </p>
              ) : (
                <div
                  className="flex items-baseline gap-2"
                  data-testid="health-since-last"
                >
                  <span className="text-3xl font-semibold tabular-nums">
                    {sinceDays}
                  </span>
                  <span className="text-sm">{s.sinceDays(sinceDays)}</span>
                </div>
              ))}
          </div>
          {sinceDays !== null && sinceDays > 0 && (
            <HealthSinceStrip days={sinceDays} />
          )}
        </div>
      </Section>

      <NeedsCheck entries={data.needs_check_entries} year={data.year} />

      <Section hint={s.yearHint} title={s.yearTitle(data.year)}>
        {empty ? (
          <p className="text-sm text-muted-foreground">{s.empty}</p>
        ) : null}
        <YearGrid days={data.days} today={data.today} year={data.year} />
      </Section>
    </>
  );
}

function RereadButton() {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const reread = useMutation({
    mutationFn: healthRescanRequest,
    onSuccess: (result) => {
      setNote(
        s.rereadDone(
          result.memos,
          result.created,
          result.updated,
          result.removed,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: healthQueryKeys.all });
    },
    onError: () => setNote(s.rereadFailed),
  });
  return (
    <section className="flex flex-col items-start gap-2 border-t border-border/50 pt-4">
      <Button
        disabled={reread.isPending}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => {
          setNote(null);
          reread.mutate();
        }}
      >
        {reread.isPending ? (
          <Loader2Icon
            className="motion-safe:animate-spin"
            data-icon="inline-start"
          />
        ) : (
          <RefreshCwIcon data-icon="inline-start" />
        )}
        {reread.isPending ? s.rereading : s.reread}
      </Button>
      <p className="text-xs text-muted-foreground">{s.rereadHint}</p>
      {note && (
        <p className="text-xs text-foreground" role="status">
          {note}
        </p>
      )}
    </section>
  );
}

export function HealthPage() {
  const today = healthLocalMoment(new Date()).day;
  const year = Number(today.slice(0, 4));
  return (
    <WorkspaceLayout
      contentMaxWidth={960}
      header={({
        sidebarCollapsed,
        toggleSidebarCollapsed,
        mobileSheetOpen,
        setMobileSheetOpen,
        explorer,
      }) => (
        <WorkspacePageHeader
          explorer={explorer}
          icon={
            <HeartPulseIcon className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />
          }
          mobileSheetOpen={mobileSheetOpen}
          setMobileSheetOpen={setMobileSheetOpen}
          sidebarCollapsed={sidebarCollapsed}
          title={healthStrings.title}
          toggleSidebarCollapsed={toggleSidebarCollapsed}
        />
      )}
    >
      <div className="flex flex-col gap-6 py-2" data-testid="health-page">
        <WeekSection />
        <YearSections year={year} />
        <HealthTrackersPanel />
        <RereadButton />
      </div>
    </WorkspaceLayout>
  );
}
