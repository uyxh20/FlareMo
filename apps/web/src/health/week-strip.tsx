import type {
  HealthEntryDto,
  HealthEntryKind,
  HealthKind,
} from "@flaremo/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { healthFetchWeek } from "./api";
import {
  type HealthDotState,
  healthDotState,
  healthFormatUnits,
  healthStripDays,
} from "./model";
import { healthQueryKeys } from "./query-keys";
import { healthStrings } from "./strings";
import {
  healthKindClass,
  healthOwnTrackers,
  useHealthTrackers,
} from "./trackers";
import "./health.css";

// The week strip on top of the diary timeline (fork-owned add-on,
// docs/fork-health-tracker.md): a compact grid of the last seven days, one row
// per kind. A filled dot is something done, a half dot is half a unit, a dashed
// ring is a night that still needs a home time. Tapping it opens the Health page.
//
// It reads `GET /week` with no start day, so the server's own "today" (the
// owner's time zone, the one the days were filed under) decides which seven days
// show. After a note is saved the timeline refreshes its stats; the strip
// listens for that and reads again.

const ROWS: Array<{ kind: HealthKind; label: string }> = [
  { kind: "training", label: healthStrings.kind.training },
  { kind: "breath", label: healthStrings.kind.breath },
  { kind: "night_out", label: healthStrings.kind.night_out },
];

const STATE_TEXT: Record<HealthDotState, string> = {
  none: "",
  done: "done",
  half: "half a unit",
  check: healthStrings.strip.needsCheck,
  zero: healthStrings.strip.beforeMidnight,
};

function Dot({
  entries,
  kind,
  kindClass,
  day,
  weekday,
}: {
  entries: readonly HealthEntryDto[];
  kind: HealthEntryKind;
  kindClass: string;
  day: string;
  weekday: string;
}) {
  const { state } = healthDotState(entries, kind, day);
  const text = STATE_TEXT[state];
  return (
    <span
      className={cn("flex h-5 items-center justify-center", kindClass)}
      data-day={day}
      data-kind={kind}
      data-state={state}
      data-testid="health-dot"
      title={text ? `${weekday} · ${text}` : undefined}
    >
      <span className="health-dot" data-state={state} />
      {text && <span className="sr-only">{`${weekday}: ${text}`}</span>}
    </span>
  );
}

export function HealthWeekStrip({ visible = true }: { visible?: boolean }) {
  const queryClient = useQueryClient();
  const trackers = useHealthTrackers().data?.trackers;
  const query = useQuery({
    queryKey: healthQueryKeys.strip("last7"),
    queryFn: () => healthFetchWeek(),
    enabled: visible,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  // A saved note refreshes the timeline's stats; the strip follows. The first
  // load of the stats (dataUpdateCount 1) is not a change.
  useEffect(() => {
    if (!visible) return;
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        event.query.queryKey[0] === "memo-stats" &&
        event.query.state.dataUpdateCount > 1
      ) {
        void queryClient.invalidateQueries({
          queryKey: healthQueryKeys.stripAll,
        });
      }
    });
  }, [queryClient, visible]);

  if (!visible) return null;
  if (query.isPending) {
    return <Skeleton className="h-[8.25rem] rounded-xl" />;
  }
  // A strip that cannot load stays out of the timeline's way.
  if (query.isError || !query.data) return null;

  const { start, today, entries, summary } = query.data;
  const own = healthOwnTrackers(trackers);
  const days = healthStripDays(start, today);
  const counts: Record<HealthKind, string> = {
    training: `${summary.training.sessions}/${summary.training.target}`,
    breath: `${summary.breath.days}/${summary.breath.target}`,
    night_out: `${healthFormatUnits(summary.night_out.year_used)}/${summary.night_out.year_target} yr`,
  };

  return (
    <Link
      aria-label={healthStrings.strip.open}
      className="block rounded-xl border border-border/50 bg-card/60 px-3.5 py-3 text-card-foreground outline-none motion-safe:animate-rise motion-safe:transition-[background-color,border-color] motion-safe:duration-150 hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/50"
      data-testid="health-week-strip"
      to="/health"
    >
      <div className="grid grid-cols-[4rem_repeat(7,minmax(0,1fr))_4.5rem] items-center gap-x-1 gap-y-0.5 text-xs">
        <span />
        {days.map((day) => (
          <span
            aria-hidden="true"
            className={cn(
              "text-center text-muted-foreground",
              day.isToday && "font-semibold text-foreground",
            )}
            key={day.day}
          >
            {day.weekday.slice(0, 1)}
          </span>
        ))}
        <span />
        {ROWS.map((row) => (
          <RowCells
            count={counts[row.kind]}
            days={days}
            entries={entries}
            key={row.kind}
            kind={row.kind}
            kindClass={`health-kind-${row.kind}`}
            label={row.label}
          />
        ))}
        {own.map((tracker) => (
          <RowCells
            count={String(
              query.data.trackers.find((count) => count.kind === tracker.kind)
                ?.days ?? 0,
            )}
            days={days}
            entries={entries}
            key={tracker.kind}
            kind={tracker.kind}
            kindClass={healthKindClass(tracker.kind, trackers)}
            label={tracker.label}
          />
        ))}
      </div>
    </Link>
  );
}

function RowCells({
  kind,
  kindClass,
  label,
  days,
  entries,
  count,
}: {
  kind: HealthEntryKind;
  kindClass: string;
  label: string;
  days: ReturnType<typeof healthStripDays>;
  entries: readonly HealthEntryDto[];
  count: string;
}) {
  return (
    <>
      <span className="truncate text-muted-foreground">{label}</span>
      {days.map((day) => (
        <Dot
          day={day.day}
          entries={entries}
          key={day.day}
          kind={kind}
          kindClass={kindClass}
          weekday={day.weekday}
        />
      ))}
      <span className="text-right tabular-nums text-muted-foreground">
        {count}
      </span>
    </>
  );
}
