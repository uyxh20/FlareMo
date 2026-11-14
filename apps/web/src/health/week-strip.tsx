import type {
  HealthEntryDto,
  HealthEntryKind,
  HealthTrackerDto,
} from "@flaremo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  type HealthBreakdown,
  HealthBreakdownDialog,
} from "./breakdown-dialog";
import {
  type HealthDotState,
  type HealthFamilyRow,
  healthBreakdownOfEntries,
  healthChipText,
  healthDotState,
  healthFamilyCount,
  healthFamilyRows,
  healthStripDays,
} from "./model";
import { healthQueryKeys } from "./query-keys";
import { healthStrings } from "./strings";
import { useHealthThisWeek } from "./this-week";
import { useHealthTrackers } from "./trackers";
import "./health.css";

// The week strip on top of the diary timeline (fork-owned add-on,
// docs/fork-health-tracker.md): a compact grid of this week, Monday to Sunday,
// one row per family (Fitness, Breath, Out, then the owner's own trackers), with
// the days each happened this week. A filled dot is something done, a half dot
// is half a unit, a dashed ring is a night that still needs a home time. A dot's
// tooltip names the sub-type ("Fri · Gym · Back"); tapping a row's name opens its
// breakdown by sub-type; tapping anywhere else opens the Health page.
//
// It shares `useHealthThisWeek` with the Health page: one request, one cache
// entry. After a note is saved the timeline refreshes its stats; the strip
// listens for that and reads again.

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
  trackers,
}: {
  trackers: readonly HealthTrackerDto[] | undefined;
  entries: readonly HealthEntryDto[];
  kind: HealthEntryKind | readonly HealthEntryKind[];
  kindClass: string;
  day: string;
  weekday: string;
}) {
  const { state } = healthDotState(entries, kind, day);
  const kinds: readonly HealthEntryKind[] = Array.isArray(kind)
    ? kind
    : [kind as HealthEntryKind];
  const here = entries.filter((e) => kinds.includes(e.kind) && e.day === day);
  // The sub-type of what happened ("Gym · Back"); a night still waiting for
  // its home time, or home before midnight, says so instead.
  const detail = here
    .map((e) =>
      healthChipText(e, trackers)
        .split(" · ")
        .slice(1)
        .filter((part) => part !== weekday)
        .join(" · "),
    )
    .filter(Boolean)
    .join(" + ");
  const text =
    state === "none"
      ? ""
      : state === "check" || state === "zero"
        ? STATE_TEXT[state]
        : detail || STATE_TEXT[state];
  return (
    <span
      className={cn("flex h-5 items-center justify-center", kindClass)}
      data-day={day}
      data-kind={Array.isArray(kind) ? kind.join("+") : kind}
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
  const navigate = useNavigate();
  const [open, setOpen] = useState<HealthBreakdown | null>(null);
  const trackers = useHealthTrackers().data?.trackers;
  const query = useHealthThisWeek({ enabled: visible });

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
          queryKey: healthQueryKeys.weekAll,
        });
      }
    });
  }, [queryClient, visible]);

  if (!visible) return null;
  if (query.isPending) {
    return <Skeleton className="h-[10.75rem] rounded-xl" />;
  }
  // A strip that cannot load stays out of the timeline's way.
  if (query.isError || !query.data) return null;

  const { start, today, entries } = query.data;
  const days = healthStripDays(start, today);
  const rows = healthFamilyRows(trackers);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a link cannot hold the row buttons.
    <div
      aria-label={healthStrings.strip.open}
      className="block cursor-pointer rounded-xl border border-border/50 bg-card/60 px-3.5 py-3 text-card-foreground outline-none motion-safe:animate-rise motion-safe:transition-[background-color,border-color] motion-safe:duration-150 hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/50"
      data-testid="health-week-strip"
      role="link"
      tabIndex={0}
      onClick={(event) => {
        // The pop-up lives in a portal: React still bubbles its clicks here,
        // but they are not inside this card, so they must not open the page.
        if (!event.currentTarget.contains(event.target as Node)) return;
        void navigate({ to: "/health" });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") void navigate({ to: "/health" });
      }}
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
        {rows.map((row) => (
          <RowCells
            count={String(healthFamilyCount(entries, row.family))}
            days={days}
            entries={entries}
            key={row.family}
            row={row}
            trackers={trackers}
            onOpen={() =>
              setOpen({
                title: healthStrings.breakdown.week(row.label),
                kindClass: row.kindClass,
                totalLabel:
                  row.family === "night_out"
                    ? healthStrings.breakdown.nights
                    : healthStrings.breakdown.sessions,
                total: healthFamilyCount(entries, row.family),
                rows: healthBreakdownOfEntries(entries, row.family, trackers),
              })
            }
          />
        ))}
      </div>
      <HealthBreakdownDialog breakdown={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function RowCells({
  row,
  days,
  entries,
  count,
  trackers,
  onOpen,
}: {
  row: HealthFamilyRow;
  days: ReturnType<typeof healthStripDays>;
  entries: readonly HealthEntryDto[];
  count: string;
  trackers: readonly HealthTrackerDto[] | undefined;
  onOpen: () => void;
}) {
  const kind =
    row.kinds.length === 1 ? (row.kinds[0] as HealthEntryKind) : row.kinds;
  return (
    <>
      <button
        aria-label={healthStrings.breakdown.open(row.label)}
        className="truncate rounded text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        data-family={row.family}
        data-testid="health-row-name"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        {row.label}
      </button>
      {days.map((day) => (
        <Dot
          day={day.day}
          entries={entries}
          key={day.day}
          kind={kind}
          kindClass={row.kindClass}
          trackers={trackers}
          weekday={day.weekday}
        />
      ))}
      <span className="text-right tabular-nums text-muted-foreground">
        {count}
      </span>
    </>
  );
}
