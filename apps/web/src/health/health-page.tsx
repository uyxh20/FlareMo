import {
  type HealthEntryDto,
  type HealthEntryKind,
  type HealthTrackerDto,
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
import { HealthHomeAnswers } from "./memo-labels";
import {
  healthDayShort,
  healthFormatUnits,
  healthLevel,
  healthMonthMarks,
  healthWeekdayShort,
  healthYearWeeks,
} from "./model";
import { healthQueryKeys } from "./query-keys";
import { healthStrings } from "./strings";
import { useHealthThisWeek } from "./this-week";
import {
  healthKindClass,
  healthOwnTrackers,
  useHealthTrackers,
} from "./trackers";
import { HealthTrackersPanel } from "./trackers-panel";
import "./health.css";

// The Health page at /health (fork-owned add-on, docs/fork-health-tracker.md):
// what happened this week (counts, no targets), the nights out so far this year
// with their pace,
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
}: {
  kind: HealthEntryKind;
  kindClass?: string;
  title: string;
  big: string;
  note: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border/50 bg-card/60 p-4",
        kindClass,
      )}
      data-kind={kind}
      data-testid="health-tile"
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
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}

function WeekSection() {
  const trackers = useHealthTrackers().data?.trackers;
  const query = useHealthThisWeek();
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
  const { start, end, summary } = query.data;
  return (
    <Section
      hint={s.weekRange(healthDayShort(start), healthDayShort(end))}
      title={s.thisWeek}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile
          big={String(summary.training.sessions)}
          kind="training"
          note={s.trainingNote(summary.training.sessions)}
          title={s.trainingTile}
        />
        <Tile
          big={String(summary.breath.days)}
          kind="breath"
          note={s.breathNote(summary.breath.days, summary.breath.minutes)}
          title={s.breathTile}
        />
        <Tile
          big={healthFormatUnits(summary.night_out.units)}
          kind="night_out"
          note={s.outNote(healthFormatUnits(summary.night_out.units))}
          title={s.outTile}
        />
        {healthOwnTrackers(trackers).map((tracker) => {
          const count = query.data.trackers.find(
            (item) => item.kind === tracker.kind,
          );
          const minutes = count?.minutes ?? 0;
          return (
            <Tile
              big={String(count?.days ?? 0)}
              key={tracker.kind}
              kind={tracker.kind}
              kindClass={healthKindClass(tracker.kind, trackers)}
              note={
                minutes > 0 && tracker.measure === "hours"
                  ? healthStrings.trackers.weekHours(minutes)
                  : minutes > 0 && tracker.measure === "minutes"
                    ? healthStrings.trackers.weekMinutes(minutes)
                    : healthStrings.trackers.weekNote(count?.days ?? 0)
              }
              title={tracker.label}
            />
          );
        })}
      </div>
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
      void queryClient.invalidateQueries({ queryKey: ["health", "memo"] });
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

type GridRow = {
  kind: HealthEntryKind;
  label: string;
  kindClass: string;
  full: number;
};

const GRID_ROWS: GridRow[] = (["training", "breath", "night_out"] as const).map(
  (kind) => ({
    kind,
    label: healthStrings.kind[kind],
    kindClass: `health-kind-${kind}`,
    full: kind === "training" ? 3 : kind === "breath" ? 7 : 2,
  }),
);

function gridRowsWith(trackers: readonly HealthTrackerDto[] | undefined) {
  return [
    ...GRID_ROWS,
    ...healthOwnTrackers(trackers).map((tracker) => ({
      kind: tracker.kind,
      label: tracker.label,
      kindClass: healthKindClass(tracker.kind, trackers),
      full: 7,
    })),
  ];
}

function YearGrid({
  year,
  today,
  days,
}: {
  year: number;
  today: string;
  days: Parameters<typeof healthYearWeeks>[1];
}) {
  const trackers = useHealthTrackers().data?.trackers;
  const weeks = healthYearWeeks(year, days, today);
  const marks = healthMonthMarks(weeks);
  const columns = `repeat(${weeks.length}, minmax(0.875rem, 1fr))`;
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
        {gridRowsWith(trackers).map((row) => {
          const label = row.label;
          return (
            <div
              className={cn("flex items-center gap-2", row.kindClass)}
              key={row.kind}
              role="img"
              aria-label={s.gridLabel(label)}
            >
              <span className="w-16 shrink-0 text-xs text-muted-foreground">
                {label}
              </span>
              <div
                className="grid flex-1 gap-[3px]"
                style={{ gridTemplateColumns: columns }}
              >
                {weeks.map((week) => {
                  const value =
                    row.kind === "training"
                      ? week.training
                      : row.kind === "breath"
                        ? week.breath
                        : row.kind === "night_out"
                          ? week.out
                          : (week.trackers[row.kind] ?? 0);
                  const text =
                    row.kind === "training"
                      ? s.sessions(value)
                      : row.kind === "night_out"
                        ? s.units(healthFormatUnits(value))
                        : s.days(value);
                  return (
                    <span
                      className="health-cell aspect-square"
                      data-future={week.future}
                      data-level={healthLevel(value, row.full)}
                      key={week.start}
                      title={
                        week.future
                          ? undefined
                          : s.cell(label, healthDayShort(week.start), text)
                      }
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
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
  const projected = Math.round(out.pace * 10) / 10;
  const empty =
    data.days.length === 0 &&
    data.totals.training === 0 &&
    data.totals.breath_days === 0;
  return (
    <>
      <Section title={s.budgetTitle(data.year)}>
        <div
          className="health-kind-night_out flex flex-col gap-2.5 rounded-xl border border-border/50 bg-card/60 p-4"
          data-testid="health-budget"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className="text-3xl font-semibold tabular-nums"
              style={{ color: "var(--k-ink)" }}
            >
              {healthFormatUnits(out.used)}
            </span>
            <span className="text-sm text-muted-foreground">
              {s.unitsSoFar}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {s.nightsLine(out.nights, out.benders)}
            {out.days_elapsed > 0 && out.used > 0 && (
              <>
                {". "}
                {s.pace(healthFormatUnits(projected))}
              </>
            )}
          </p>
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
      maxWidthClass="max-w-[960px]"
      outerMaxWidthClass="max-w-[1600px]"
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
          maxWidthClass="max-w-[960px]"
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
