import {
  type PlannerGoalDto,
  type PlannerGoalLevel,
  type PlannerGoalsYearResponse,
  type PlannerPillar,
  type PlannerWeekDto,
  plannerPillars,
  plannerScoreFloors,
} from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { FileTextIcon, PencilIcon, PlusIcon, TargetIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { QueryErrorState } from "@/components/query-error-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { WorkspacePageHeader } from "@/components/workspace/workspace-page-header";
import { cn, stripResourceName } from "@/lib/utils";
import { PlannerPillarLabel, plannerPillarClass } from "./goal-cards";
import { PlannerGoalEditor, type PlannerGoalEditorTarget } from "./goal-editor";
import { plannerFetchGoalsYear } from "./goals-api";
import {
  type PlannerWeekStats,
  plannerAverageText,
  plannerCellKind,
  plannerCellLines,
  plannerGoalsOf,
  plannerGoalText,
  plannerIsoYearOf,
  plannerIsScored,
  plannerMonthStart,
  plannerPeriodGoals,
  plannerQuarterMonths,
  plannerQuarterStart,
  plannerScoreText,
  plannerWeekGoalCounts,
  plannerWeekNumber,
  plannerWeekPlace,
  plannerWeekRange,
  plannerWeekStats,
  plannerWeeksByMonday,
  plannerYearMonths,
} from "./goals-model";
import type { PlannerGoalsSearch } from "./goals-search";
import {
  type PlannerGoalsStrings,
  usePlannerGoalsStrings,
} from "./goals-strings";
import {
  PlannerCrumbs,
  PlannerGoalBody,
  PlannerGoalStatusBadge,
  PlannerSectionTitle,
  PlannerTile,
} from "./goals-ui";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerToday } from "./use-planner-clock";
import "./goals.css";

// The Goals page at /goals (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the cascade from the north star down to
// a week, one level per address. The year shows the north star, the averages of
// its weeks, a heatmap of every week and the year goals; a quarter shows its
// months and goals; a month its goals and weeks; a week its scores and weekly
// goals, with a link to its summary memo. Every goal opens in the goal editor.
//
// Weeks are ISO weeks, each shown under its Thursday's month; the averages only
// count weeks that have ended.

type Place =
  | { level: "year"; year: number }
  | { level: "quarter"; year: number; quarter: number }
  | { level: "month"; year: number; quarter: number; month: number }
  | {
      level: "week";
      year: number;
      quarter: number;
      month: number;
      week: string;
    };

/** Where the address points; `month` is 0 to 11. */
function placeOf(search: PlannerGoalsSearch, today: string): Place {
  if (search.week) {
    return {
      level: "week",
      ...plannerWeekPlace(search.week),
      week: search.week,
    };
  }
  const year = search.year ?? plannerIsoYearOf(today);
  if (search.q === undefined) return { level: "year", year };
  if (search.m === undefined)
    return { level: "quarter", year, quarter: search.q };
  return { level: "month", year, quarter: search.q, month: search.m - 1 };
}

function crumbsOf(place: Place, strings: PlannerGoalsStrings) {
  const items: Array<{ label: string; search?: PlannerGoalsSearch }> = [
    { label: strings.goals.year(place.year), search: { year: place.year } },
  ];
  if (place.level === "year") return items;
  items.push({
    label: strings.goals.quarter(place.quarter),
    search: { year: place.year, q: place.quarter },
  });
  if (place.level === "quarter") return items;
  items.push({
    label: strings.monthsLong[place.month] ?? "",
    search: { year: place.year, q: place.quarter, m: place.month + 1 },
  });
  if (place.level === "week") {
    items.push({ label: strings.week(plannerWeekNumber(place.week)) });
  }
  return items;
}

type Edit = (target: PlannerGoalEditorTarget) => void;

export function PlannerGoalsPage() {
  const strings = usePlannerGoalsStrings();
  const today = usePlannerToday();
  const search = useSearch({ from: "/goals" });
  const place = placeOf(search, today);
  const [editing, setEditing] = useState<PlannerGoalEditorTarget | null>(null);

  const query = useQuery({
    queryKey: plannerQueryKeys.goalsYear(place.year, today),
    queryFn: () => plannerFetchGoalsYear({ year: place.year, today }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const data = query.data?.year === place.year ? query.data : undefined;

  let content: ReactNode;
  if (!data && query.isError) {
    content = (
      <QueryErrorState
        className="min-h-56"
        isRetrying={query.isRefetching}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (!data) {
    content = <GoalsSkeleton />;
  } else if (place.level === "year") {
    content = (
      <YearView
        data={data}
        strings={strings}
        year={place.year}
        onEdit={setEditing}
      />
    );
  } else if (place.level === "quarter") {
    content = (
      <QuarterView
        data={data}
        quarter={place.quarter}
        strings={strings}
        year={place.year}
        onEdit={setEditing}
      />
    );
  } else if (place.level === "month") {
    content = (
      <MonthView
        data={data}
        month={place.month}
        strings={strings}
        year={place.year}
        onEdit={setEditing}
      />
    );
  } else {
    content = (
      <WeekView
        data={data}
        strings={strings}
        week={place.week}
        onEdit={setEditing}
      />
    );
  }

  return (
    <WorkspaceLayout
      maxWidthClass="max-w-[1080px]"
      outerMaxWidthClass="max-w-[1400px]"
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
            <TargetIcon className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />
          }
          maxWidthClass="max-w-[1080px]"
          mobileSheetOpen={mobileSheetOpen}
          setMobileSheetOpen={setMobileSheetOpen}
          sidebarCollapsed={sidebarCollapsed}
          title={strings.goals.title}
          toggleSidebarCollapsed={toggleSidebarCollapsed}
        />
      )}
    >
      <div
        className="flex flex-col gap-7 py-2 pb-16"
        data-testid="planner-goals"
      >
        <PlannerCrumbs
          items={crumbsOf(place, strings)}
          label={strings.goals.breadcrumb}
        />
        {content}
      </div>
      <PlannerGoalEditor target={editing} onClose={() => setEditing(null)} />
    </WorkspaceLayout>
  );
}

function GoalsSkeleton() {
  return (
    <div className="flex flex-col gap-7" data-testid="planner-goals-loading">
      <Skeleton className="h-14 max-w-[62ch]" />
      <div className="grid max-w-[760px] grid-cols-3 gap-2 sm:gap-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-44" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    </div>
  );
}

// --- Levels -----------------------------------------------------------------

type ViewProps = {
  data: PlannerGoalsYearResponse;
  strings: PlannerGoalsStrings;
  onEdit: Edit;
};

function YearView({
  data,
  strings,
  year,
  onEdit,
}: ViewProps & { year: number }) {
  const records = plannerWeeksByMonday(data.weeks);
  const months = plannerYearMonths(year);
  const stats = plannerWeekStats(months.flat(), records, data.current_week);
  const start = plannerMonthStart(year, 0);
  const { theme, goals } = plannerPeriodGoals(data.goals, "year", start);
  return (
    <>
      <div className="flex flex-col gap-5">
        <Theme
          editLabel={strings.editor.edit(strings.goals.northStar)}
          empty={strings.goals.noNorthStar}
          eyebrow={strings.goals.northStar}
          goal={data.north_star}
          strings={strings}
          onAdd={() =>
            onEdit({
              kind: "new",
              level: "north_star",
              periodStart: null,
              pillar: null,
            })
          }
          onEdit={onEdit}
        />
        {theme && (
          <Theme
            editLabel={strings.editor.edit(strings.goals.year(year))}
            eyebrow={strings.goals.year(year)}
            goal={theme}
            strings={strings}
            onEdit={onEdit}
          />
        )}
      </div>
      <StatTiles stats={stats} strings={strings} />
      <section>
        <PlannerSectionTitle>{strings.goals.weeks}</PlannerSectionTitle>
        <Heatmap
          counts={plannerWeekGoalCounts(data.goals)}
          currentWeek={data.current_week}
          months={months}
          records={records}
          strings={strings}
          year={year}
        />
        <Legend strings={strings} />
      </section>
      <section>
        <PlannerSectionTitle>{strings.goals.yearGoals}</PlannerSectionTitle>
        <GoalCards
          goals={goals}
          level="year"
          periodStart={start}
          strings={strings}
          onEdit={onEdit}
        />
      </section>
    </>
  );
}

function QuarterView({
  data,
  strings,
  year,
  quarter,
  onEdit,
}: ViewProps & { year: number; quarter: number }) {
  const records = plannerWeeksByMonday(data.weeks);
  const yearMonths = plannerYearMonths(year);
  const months = plannerQuarterMonths(quarter);
  const stats = plannerWeekStats(
    months.flatMap((month) => yearMonths[month] ?? []),
    records,
    data.current_week,
  );
  const start = plannerQuarterStart(year, quarter);
  const { theme, goals } = plannerPeriodGoals(data.goals, "quarter", start);
  const name = strings.goals.quarter(quarter);
  const span = `${strings.months[months[0] ?? 0]} – ${strings.months[months[2] ?? 0]}`;
  return (
    <>
      <Theme
        editLabel={strings.editor.edit(name)}
        eyebrow={`${name} · ${span}`}
        goal={theme}
        strings={strings}
        onAdd={() =>
          onEdit({
            kind: "new",
            level: "quarter",
            periodStart: start,
            pillar: null,
          })
        }
        onEdit={onEdit}
      />
      <StatTiles stats={stats} strings={strings} />
      <section>
        <PlannerSectionTitle>{strings.goals.months}</PlannerSectionTitle>
        <div className="flex flex-col gap-2.5">
          {months.map((month) => {
            const mondays = yearMonths[month] ?? [];
            const monthStats = plannerWeekStats(
              mondays,
              records,
              data.current_week,
            );
            return (
              <Link
                className="grid grid-cols-[1fr_auto] items-center gap-x-3.5 gap-y-2 rounded-xl border border-border bg-card px-3 py-2.5 outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50 sm:grid-cols-[150px_auto_1fr]"
                key={month}
                search={{ year, q: quarter, m: month + 1 }}
                to="/goals"
              >
                <span className="font-semibold">
                  {strings.monthsLong[month]}
                </span>
                <span
                  aria-hidden="true"
                  className="col-span-full flex gap-[3px] max-sm:order-3 sm:col-span-1 sm:gap-1"
                >
                  {mondays.map((monday) => (
                    <span
                      className="planner-cell"
                      data-kind={plannerCellKind(
                        monday,
                        data.current_week,
                        records.get(monday),
                      )}
                      key={monday}
                    />
                  ))}
                </span>
                <span className="justify-self-end font-mono text-[13px] text-muted-foreground tabular-nums">
                  {monthStats.auth !== null && monthStats.ach !== null
                    ? strings.goals.scores(
                        plannerAverageText(monthStats.auth),
                        plannerAverageText(monthStats.ach),
                      )
                    : "—"}
                </span>
              </Link>
            );
          })}
        </div>
        <Legend strings={strings} />
      </section>
      <section>
        <PlannerSectionTitle>{strings.goals.quarterGoals}</PlannerSectionTitle>
        <GoalCards
          goals={goals}
          level="quarter"
          periodStart={start}
          strings={strings}
          onEdit={onEdit}
        />
      </section>
    </>
  );
}

function MonthView({
  data,
  strings,
  year,
  month,
  onEdit,
}: ViewProps & { year: number; month: number }) {
  const records = plannerWeeksByMonday(data.weeks);
  const mondays = plannerYearMonths(year)[month] ?? [];
  const stats = plannerWeekStats(mondays, records, data.current_week);
  const counts = plannerWeekGoalCounts(data.goals);
  const start = plannerMonthStart(year, month);
  const { theme, goals } = plannerPeriodGoals(data.goals, "month", start);
  const name = strings.monthsLong[month] ?? "";
  return (
    <>
      {theme && (
        <Theme
          editLabel={strings.editor.edit(name)}
          eyebrow={name}
          goal={theme}
          strings={strings}
          onEdit={onEdit}
        />
      )}
      <StatTiles stats={stats} strings={strings} />
      <section>
        <PlannerSectionTitle>{strings.goals.monthGoals}</PlannerSectionTitle>
        <div className="flex flex-col gap-2">
          {bySlot(goals).map((slot) =>
            slot.kind === "goal" ? (
              <MonthGoalRow
                goal={slot.goal}
                key={slot.goal.id}
                strings={strings}
                onEdit={onEdit}
              />
            ) : (
              <div
                className={cn(
                  "grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-xl border border-dashed border-border px-3 py-2 sm:grid-cols-[170px_1fr_auto]",
                  plannerPillarClass(slot.pillar),
                )}
                key={`empty-${slot.pillar}`}
              >
                <PlannerPillarLabel
                  className="max-sm:col-span-full"
                  pillar={slot.pillar}
                  strings={strings}
                />
                <span className="text-sm text-muted-foreground">
                  {strings.goals.noGoal}
                </span>
                <AddButton
                  label={strings.editor.add}
                  onClick={() =>
                    onEdit({
                      kind: "new",
                      level: "month",
                      periodStart: start,
                      pillar: slot.pillar,
                    })
                  }
                />
              </div>
            ),
          )}
        </div>
      </section>
      <section>
        <PlannerSectionTitle>{strings.goals.weeks}</PlannerSectionTitle>
        <div className="flex flex-col gap-2">
          {mondays.map((monday) => (
            <WeekRow
              count={counts.get(monday) ?? 0}
              currentWeek={data.current_week}
              key={monday}
              monday={monday}
              record={records.get(monday)}
              strings={strings}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function WeekView({
  data,
  strings,
  week,
  onEdit,
}: ViewProps & { week: string }) {
  const record = plannerWeeksByMonday(data.weeks).get(week);
  const current = data.current_week;
  const goals = plannerGoalsOf(data.goals, "week", week);
  const line = [
    plannerWeekRange(week, strings),
    week === current ? strings.goals.thisWeek : null,
    week !== current ? record?.note : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <p className="-mt-3 max-w-[72ch] text-sm text-muted-foreground">{line}</p>
      {week < current &&
        (plannerIsScored(record) ? (
          <div className="grid max-w-[760px] grid-cols-3 gap-2 sm:gap-3">
            <PlannerTile
              extra={
                <FloorTag
                  floor={plannerScoreFloors.auth}
                  strings={strings}
                  value={record.auth}
                />
              }
              label={strings.goals.authenticity}
              value={plannerScoreText(record.auth)}
            />
            <PlannerTile
              extra={
                <FloorTag
                  floor={plannerScoreFloors.ach}
                  strings={strings}
                  value={record.ach}
                />
              }
              label={strings.goals.achievement}
              value={plannerScoreText(record.ach)}
            />
            <PlannerTile
              label={strings.goals.gap}
              value={plannerScoreText(Math.abs(record.auth - record.ach))}
            />
          </div>
        ) : (
          <div className="grid max-w-[760px] grid-cols-3 gap-2 sm:gap-3">
            <PlannerTile label={strings.goals.notScored} value="—" />
          </div>
        ))}
      <section>
        <PlannerSectionTitle
          action={
            <AddButton
              label={strings.editor.add}
              onClick={() =>
                onEdit({
                  kind: "new",
                  level: "week",
                  periodStart: week,
                  pillar: null,
                })
              }
            />
          }
        >
          {strings.goals.weeklyGoals}
        </PlannerSectionTitle>
        {goals.length > 0 ? (
          <div className="flex max-w-[640px] flex-col gap-2">
            {goals.map((goal) => (
              <WeekGoalRow
                goal={goal}
                key={goal.id}
                strings={strings}
                onEdit={onEdit}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {strings.goals.noGoalsSet}
          </p>
        )}
        {record?.memo_id && (
          <Button
            className="mt-4"
            render={
              <Link
                params={{ memoId: stripResourceName(record.memo_id, "memos") }}
                to="/memo/$memoId"
              />
            }
            variant="outline"
          >
            <FileTextIcon data-icon="inline-start" />
            {strings.goals.summary}
          </Button>
        )}
      </section>
    </>
  );
}

// --- Pieces -----------------------------------------------------------------

/** The line a level opens with: the north star, or a period's theme. */
function Theme({
  eyebrow,
  goal,
  empty,
  editLabel,
  strings,
  onEdit,
  onAdd,
}: {
  eyebrow: string;
  goal: PlannerGoalDto | null;
  empty?: string;
  editLabel: string;
  strings: PlannerGoalsStrings;
  onEdit: Edit;
  onAdd?: () => void;
}) {
  return (
    <section className="max-w-[62ch]">
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-[0.07em] text-muted-foreground uppercase">
          {eyebrow}
        </span>
        {goal && <PlannerGoalStatusBadge goal={goal} strings={strings} />}
        {goal ? (
          <EditButton
            label={editLabel}
            onClick={() => onEdit({ kind: "edit", goal })}
          />
        ) : (
          onAdd && <AddButton label={strings.editor.add} onClick={onAdd} />
        )}
      </div>
      {goal ? (
        <div className="mt-1 flex flex-col gap-2.5">
          {goal.title && (
            <p className="text-[17px] leading-[1.45] font-medium">
              {goal.title}
            </p>
          )}
          {goal.lines.length > 0 && (
            <PlannerGoalBody goal={{ title: "", lines: goal.lines }} />
          )}
        </div>
      ) : (
        empty && (
          <p className="mt-1 text-[15px] text-muted-foreground">{empty}</p>
        )
      )}
    </section>
  );
}

function FloorTag({
  value,
  floor,
  strings,
}: {
  value: number;
  floor: number;
  strings: PlannerGoalsStrings;
}) {
  const below = value < floor;
  return (
    <span className={cn("font-mono text-xs", below && "text-warning")}>
      {below ? "↓ " : ""}
      {strings.goals.floor(plannerScoreText(floor))}
    </span>
  );
}

/** The averages of a span of weeks; nothing until one of them is scored. */
function StatTiles({
  stats,
  strings,
}: {
  stats: PlannerWeekStats;
  strings: PlannerGoalsStrings;
}) {
  if (stats.auth === null || stats.ach === null) return null;
  return (
    <div className="grid max-w-[760px] grid-cols-3 gap-2 sm:gap-3">
      <PlannerTile
        extra={
          <FloorTag
            floor={plannerScoreFloors.auth}
            strings={strings}
            value={stats.auth}
          />
        }
        label={strings.goals.authenticity}
        value={plannerAverageText(stats.auth)}
      />
      <PlannerTile
        extra={
          <FloorTag
            floor={plannerScoreFloors.ach}
            strings={strings}
            value={stats.ach}
          />
        }
        label={strings.goals.achievement}
        value={plannerAverageText(stats.ach)}
      />
      <PlannerTile
        label={strings.goals.weeksOnTarget}
        value={
          <>
            {stats.onTarget}
            <span className="text-[0.6em] font-normal text-muted-foreground">
              {" "}
              / {stats.scored}
            </span>
          </>
        }
      />
    </div>
  );
}

function Heatmap({
  year,
  months,
  records,
  counts,
  currentWeek,
  strings,
}: {
  year: number;
  months: string[][];
  records: ReadonlyMap<string, PlannerWeekDto>;
  counts: ReadonlyMap<string, number>;
  currentWeek: string;
  strings: PlannerGoalsStrings;
}) {
  return (
    <div className="flex flex-col gap-3 overflow-x-auto px-0.5 pt-1 pb-1">
      {[1, 2, 3, 4].map((quarter) => (
        <div
          className="grid grid-cols-[30px_auto] items-start gap-2.5 sm:grid-cols-[44px_auto]"
          key={quarter}
        >
          <Link
            className="pt-px text-sm font-semibold hover:text-brand-600 dark:hover:text-brand-300"
            search={{ year, q: quarter }}
            to="/goals"
          >
            {strings.goals.quarter(quarter)}
          </Link>
          <div className="flex gap-2.5 sm:gap-3.5">
            {plannerQuarterMonths(quarter).map((month) => (
              <div className="flex flex-col gap-1.5" key={month}>
                <Link
                  className="text-xs text-muted-foreground hover:text-foreground"
                  search={{ year, q: quarter, m: month + 1 }}
                  to="/goals"
                >
                  {strings.months[month]}
                </Link>
                <div className="flex gap-[3px] sm:gap-1">
                  {(months[month] ?? []).map((monday) => (
                    <WeekCell
                      count={counts.get(monday) ?? 0}
                      currentWeek={currentWeek}
                      key={monday}
                      monday={monday}
                      record={records.get(monday)}
                      strings={strings}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A week in the heatmap: a link once the week has started, its numbers on hover. */
function WeekCell({
  monday,
  currentWeek,
  record,
  count,
  strings,
}: {
  monday: string;
  currentWeek: string;
  record: PlannerWeekDto | undefined;
  count: number;
  strings: PlannerGoalsStrings;
}) {
  const kind = plannerCellKind(monday, currentWeek, record);
  const lines = plannerCellLines(monday, currentWeek, record, count, strings);
  const cell =
    monday <= currentWeek ? (
      <Link
        aria-label={lines.join(", ")}
        className="planner-cell outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        data-kind={kind}
        data-testid="planner-week-cell"
        search={{ week: monday }}
        to="/goals"
      />
    ) : (
      <span className="planner-cell" data-kind={kind} />
    );
  return (
    <Tooltip>
      <TooltipTrigger render={cell} />
      <TooltipContent className="whitespace-pre-line tabular-nums">
        {lines.join("\n")}
      </TooltipContent>
    </Tooltip>
  );
}

function Legend({ strings }: { strings: PlannerGoalsStrings }) {
  const items = [
    ["on", strings.goals.onTarget],
    ["below", strings.goals.below],
    ["none", strings.goals.notScored],
    ["future", strings.goals.notYet],
    ["now", strings.goals.thisWeek],
  ] as const;
  return (
    <ul
      aria-label={strings.goals.legend}
      className="mt-3.5 flex flex-wrap items-center gap-x-4.5 gap-y-2 text-[13px] text-muted-foreground"
    >
      {items.map(([kind, label]) => (
        <li className="inline-flex items-center gap-2" key={kind}>
          <i
            aria-hidden="true"
            className={cn("planner-cell", kind === "now" && "ml-1")}
            data-kind={kind}
            data-size="small"
          />
          {label}
        </li>
      ))}
    </ul>
  );
}

type Slot =
  | { kind: "goal"; goal: PlannerGoalDto }
  | { kind: "empty"; pillar: PlannerPillar };

/** Goals by objective, an empty slot for each objective with none, the rest last. */
function bySlot(goals: readonly PlannerGoalDto[]): Slot[] {
  const slots: Slot[] = [];
  for (const pillar of plannerPillars) {
    const mine = goals.filter((goal) => goal.pillar === pillar);
    if (mine.length === 0) slots.push({ kind: "empty", pillar });
    for (const goal of mine) slots.push({ kind: "goal", goal });
  }
  for (const goal of goals.filter((item) => item.pillar === null)) {
    slots.push({ kind: "goal", goal });
  }
  return slots;
}

function GoalCards({
  goals,
  level,
  periodStart,
  strings,
  onEdit,
}: {
  goals: readonly PlannerGoalDto[];
  level: PlannerGoalLevel;
  periodStart: string;
  strings: PlannerGoalsStrings;
  onEdit: Edit;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {bySlot(goals).map((slot) =>
        slot.kind === "goal" ? (
          <article
            className={cn(
              "flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card px-4 pt-3 pb-4",
              plannerPillarClass(slot.goal.pillar),
            )}
            data-testid="planner-goal"
            key={slot.goal.id}
          >
            <div className="flex min-h-7 items-center gap-2">
              <PlannerPillarLabel pillar={slot.goal.pillar} strings={strings} />
              <span className="ml-auto flex items-center gap-1">
                <PlannerGoalStatusBadge goal={slot.goal} strings={strings} />
                <EditButton
                  label={strings.editor.edit(
                    slot.goal.pillar
                      ? strings.pillar[slot.goal.pillar]
                      : strings.noPillar,
                  )}
                  onClick={() => onEdit({ kind: "edit", goal: slot.goal })}
                />
              </span>
            </div>
            <PlannerGoalBody goal={slot.goal} />
          </article>
        ) : (
          <div
            className={cn(
              "flex min-h-24 flex-col items-start gap-2 rounded-xl border border-dashed border-border px-4 pt-3 pb-3",
              plannerPillarClass(slot.pillar),
            )}
            key={`empty-${slot.pillar}`}
          >
            <span className="flex min-h-7 items-center">
              <PlannerPillarLabel pillar={slot.pillar} strings={strings} />
            </span>
            <span className="text-sm text-muted-foreground">
              {strings.goals.noGoal}
            </span>
            <AddButton
              label={strings.editor.add}
              onClick={() =>
                onEdit({ kind: "new", level, periodStart, pillar: slot.pillar })
              }
            />
          </div>
        ),
      )}
    </div>
  );
}

function MonthGoalRow({
  goal,
  strings,
  onEdit,
}: {
  goal: PlannerGoalDto;
  strings: PlannerGoalsStrings;
  onEdit: Edit;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-card px-3 py-2 sm:grid-cols-[170px_1fr_auto]",
        plannerPillarClass(goal.pillar),
      )}
      data-testid="planner-goal"
    >
      <PlannerPillarLabel
        className="max-sm:col-span-full"
        pillar={goal.pillar}
        strings={strings}
      />
      <span className="min-w-0 text-sm leading-snug">
        {plannerGoalText(goal)}
      </span>
      <span className="flex items-center gap-1">
        <PlannerGoalStatusBadge goal={goal} strings={strings} />
        <EditButton
          label={strings.editor.edit(
            goal.pillar ? strings.pillar[goal.pillar] : strings.noPillar,
          )}
          onClick={() => onEdit({ kind: "edit", goal })}
        />
      </span>
    </div>
  );
}

function WeekRow({
  monday,
  currentWeek,
  record,
  count,
  strings,
}: {
  monday: string;
  currentWeek: string;
  record: PlannerWeekDto | undefined;
  count: number;
  strings: PlannerGoalsStrings;
}) {
  const started = monday <= currentWeek;
  const status =
    monday === currentWeek
      ? strings.goals.thisWeek
      : monday > currentWeek
        ? strings.goals.notYet
        : count
          ? strings.goals.goalCount(count)
          : strings.goals.noGoalsSet;
  const score = plannerIsScored(record)
    ? strings.goals.scores(
        plannerScoreText(record.auth),
        plannerScoreText(record.ach),
      )
    : monday < currentWeek
      ? strings.goals.notScored
      : "";
  const inner = (
    <>
      <span
        aria-hidden="true"
        className="planner-cell"
        data-kind={plannerCellKind(monday, currentWeek, record)}
      />
      <span className="min-w-0 truncate">
        <span className="font-semibold">
          {strings.weekCode(plannerWeekNumber(monday))}
        </span>{" "}
        <span className="text-muted-foreground">
          {plannerWeekRange(monday, strings)}
        </span>
      </span>
      <span className="text-sm text-muted-foreground max-sm:hidden">
        {status}
      </span>
      <span className="justify-self-end font-mono text-[13px] text-muted-foreground tabular-nums">
        {score}
      </span>
    </>
  );
  const className =
    "grid grid-cols-[auto_1fr_auto] items-center gap-3.5 rounded-xl border border-border bg-card px-3 py-2.5 sm:grid-cols-[auto_190px_1fr_auto]";
  return started ? (
    <Link
      className={cn(
        className,
        "outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
      search={{ week: monday }}
      to="/goals"
    >
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}

const MARK = { met: "✓", partial: "◐", missed: "✕" } as const;

function WeekGoalRow({
  goal,
  strings,
  onEdit,
}: {
  goal: PlannerGoalDto;
  strings: PlannerGoalsStrings;
  onEdit: Edit;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2",
        plannerPillarClass(goal.pillar),
      )}
      data-testid="planner-goal"
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-[18px] flex-none text-center font-mono text-[13px]",
          goal.result === "met" && "text-success",
          goal.result === "partial" && "text-warning",
          goal.result === "missed" && "text-destructive",
          !goal.result && "text-muted-foreground/60",
        )}
      >
        {goal.result ? MARK[goal.result] : "·"}
      </span>
      <span className="sr-only">
        {goal.result ? strings.result[goal.result] : strings.editor.noResult}
      </span>
      {goal.pillar && (
        <PlannerPillarLabel pillar={goal.pillar} short strings={strings} />
      )}
      <span className="min-w-0 flex-1 text-sm leading-snug">
        {plannerGoalText(goal)}
      </span>
      <EditButton
        label={strings.editor.edit(
          goal.pillar ? strings.pillar[goal.pillar] : strings.noPillar,
        )}
        onClick={() => onEdit({ kind: "edit", goal })}
      />
    </div>
  );
}

function EditButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      className="text-muted-foreground"
      size="icon-sm"
      title={label}
      variant="ghost"
      onClick={onClick}
    >
      <PencilIcon className="size-3.5" />
    </Button>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      className="text-muted-foreground"
      size="sm"
      variant="ghost"
      onClick={onClick}
    >
      <PlusIcon data-icon="inline-start" />
      {label}
    </Button>
  );
}
