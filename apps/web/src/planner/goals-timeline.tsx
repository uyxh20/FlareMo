import {
  type PlannerGoalDto,
  type PlannerPillar,
  plannerPillars,
} from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { plannerFetchBoard } from "./api";
import { plannerPillarClass } from "./goal-cards";
import type { PlannerGoalEditorTarget } from "./goal-editor";
import { plannerCellLines, plannerGoalText } from "./goals-model";
import type { PlannerGoalsStrings } from "./goals-strings";
import {
  type PlannerGoalsView,
  type PlannerTimelineRow,
  plannerTimelineRows,
  plannerTimelineStartMonth,
} from "./goals-timeline-model";
import { plannerQueryKeys } from "./query-keys";
import { initialFollow, MapUnit, Split, shortDay, TaskPop } from "./year-map";
import {
  type PlannerYearMapData,
  plannerGoalParts,
  plannerGoalTasks,
  plannerMapInitialWeeks,
  plannerMapIsEmpty,
  plannerMapMark,
  plannerToggleMonthWeeks,
} from "./year-map-model";

// The Goals page's timeline (fork-owned add-on, 2026-11-12): the page's default
// view. Months run left to right, the current one first on screen; each
// objective is a row, its quarter goals lying across their three months, its
// month goals under them, and the open weeks' goals under those. The
// objective's name and year goal stay pinned on the left while the months
// scroll. Following one objective leaves only its row. It draws the same data
// with the same cards, editor and task pop-up as the grid (year-map.tsx),
// which the view switch brings back.

type Edit = (target: PlannerGoalEditorTarget) => void;

/** The switch between the timeline and the grid. */
export function PlannerGoalsViewToggle({
  view,
  strings,
  onChange,
}: {
  view: PlannerGoalsView;
  strings: PlannerGoalsStrings;
  onChange: (view: PlannerGoalsView) => void;
}) {
  return (
    <fieldset aria-label={strings.map.view} className="planner-viewtoggle">
      {(["timeline", "grid"] as const).map((option) => (
        <button
          aria-pressed={view === option}
          data-testid={`planner-goals-view-${option}`}
          key={option}
          type="button"
          onClick={() => onChange(option)}
        >
          {strings.map[option]}
        </button>
      ))}
    </fieldset>
  );
}

export function PlannerGoalsTimeline({
  map,
  currentWeek,
  today,
  strings,
  onEdit,
  toolbar,
}: {
  map: PlannerYearMapData;
  currentWeek: string;
  today: string;
  strings: PlannerGoalsStrings;
  onEdit: Edit;
  /** Sits at the end of the picker's row: the Goals page's view switch. */
  toolbar?: ReactNode;
}) {
  const [follow, setFollow] = useState<PlannerPillar | null>(initialFollow);
  const [open, setOpen] = useState<Set<string>>(() =>
    plannerMapInitialWeeks(map),
  );
  const [popGoal, setPopGoal] = useState<PlannerGoalDto | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const board = useQuery({
    queryKey: plannerQueryKeys.goalsBoard(today),
    queryFn: () => plannerFetchBoard({ today, doneDays: 366 }),
    staleTime: 30_000,
  });

  const months = map.quarters.flatMap((quarter) => quarter.months);
  const rows = plannerTimelineRows(map, follow);
  const startMonth = plannerTimelineStartMonth(map);
  const anyOpen = months.some((month) =>
    month.weeks.some((week) => open.has(week.monday)),
  );

  // Open on today: the current month is the first one on screen, right after
  // the pinned names. Earlier months are a scroll to the left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pinned column comes and goes with `follow`
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const target = box.querySelector<HTMLElement>(
      `[data-month="${startMonth}"]`,
    );
    const pinned = box.querySelector<HTMLElement>(".planner-tl-label");
    if (target) {
      box.scrollLeft = target.offsetLeft - (pinned ? pinned.offsetWidth : 0);
    }
  }, [startMonth, follow]);

  const toggleWeek = (monday: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(monday)) next.delete(monday);
      else next.add(monday);
      return next;
    });

  const editUnit = (goal: PlannerGoalDto) => (
    <MapUnit
      goal={goal}
      key={goal.id}
      mark={plannerMapMark(goal)}
      progress
      strings={strings}
      onClick={() => onEdit({ kind: "edit", goal })}
    />
  );

  const weekUnit = (goal: PlannerGoalDto) => {
    const tasks = plannerGoalTasks(goal.id, board.data);
    return (
      <MapUnit
        goal={goal}
        key={goal.id}
        label={strings.map.tasksFor(plannerGoalText(goal))}
        mark={plannerMapMark(goal, {
          total: tasks.length,
          done: tasks.filter((task) => task.column === "done").length,
        })}
        strings={strings}
        onClick={() => setPopGoal(goal)}
      />
    );
  };

  /** One period's cell in a row: its goals, or a "+" to add the first one. */
  const cell = (
    row: PlannerTimelineRow,
    key: string | number,
    goals: PlannerGoalDto[],
    options: {
      strong?: boolean;
      current?: boolean;
      span?: boolean;
      top?: boolean;
      add: PlannerGoalEditorTarget;
    },
  ) => (
    <div
      className={cn(
        "planner-yc",
        options.span && "planner-tl-span",
        options.top && "planner-tl-top",
        plannerPillarClass(row.pillar),
      )}
      key={key}
    >
      {goals.length > 0 ? (
        <Split
          current={options.current ?? false}
          strong={options.strong ?? false}
        >
          {goals.map(editUnit)}
        </Split>
      ) : (
        row.pillar && (
          <button
            aria-label={`${strings.editor.add} · ${strings.pillar[row.pillar]}`}
            className="planner-u planner-u-add"
            title={`${strings.editor.add} · ${strings.pillar[row.pillar]}`}
            type="button"
            onClick={() => onEdit(options.add)}
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </button>
        )
      )}
    </div>
  );

  const yearAdd = (pillar: PlannerPillar | null): PlannerGoalEditorTarget => ({
    kind: "new",
    level: "year",
    periodStart: map.start,
    pillar,
  });

  const rowName = (row: PlannerTimelineRow) =>
    row.pillar ? strings.pillar[row.pillar] : strings.noPillar;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="planner-viewbar">
        <fieldset aria-label={strings.map.follow} className="planner-picker">
          <button
            aria-pressed={follow === null}
            type="button"
            onClick={() => setFollow(null)}
          >
            {strings.map.allPillars}
          </button>
          {plannerPillars.map((pillar) => (
            <button
              aria-pressed={follow === pillar}
              className={plannerPillarClass(pillar)}
              key={pillar}
              type="button"
              onClick={() => setFollow(pillar)}
            >
              <i aria-hidden="true" className="planner-dot" />
              {strings.pillar[pillar]}
            </button>
          ))}
        </fieldset>
        {toolbar}
      </div>
      <div className="planner-tl-star">
        <span className="planner-yl is-star">{strings.goals.northStar}</span>
        {map.northStar ? (
          <button
            className="planner-ystar"
            title={strings.editor.edit(strings.goals.northStar)}
            type="button"
            onClick={() =>
              map.northStar && onEdit({ kind: "edit", goal: map.northStar })
            }
          >
            {plannerGoalText(map.northStar)}
          </button>
        ) : (
          <button
            className="planner-ystar planner-theme-add"
            type="button"
            onClick={() =>
              onEdit({
                kind: "new",
                level: "north_star",
                periodStart: null,
                pillar: null,
              })
            }
          >
            {strings.goals.noNorthStar}
          </button>
        )}
        {follow && (
          <>
            <span className="planner-yl is-period">
              {strings.goals.year(map.year)}
            </span>
            {cell(rows[0] as PlannerTimelineRow, "year", rows[0]?.year ?? [], {
              strong: true,
              add: yearAdd(follow),
            })}
          </>
        )}
      </div>
      <div className="planner-tl-scroll" ref={scroller}>
        <div
          className={cn("planner-tl", follow && "is-following")}
          data-testid="planner-goals-timeline"
        >
          {!follow && <span className="planner-tl-label planner-tl-corner" />}
          {map.quarters.map((quarter) => (
            <span
              className="planner-yl is-period planner-tl-q"
              key={quarter.quarter}
            >
              <b>{strings.goals.quarter(quarter.quarter)}</b>
            </span>
          ))}
          {months.map((month) => {
            const mondays = month.weeks.map((week) => week.monday);
            const allOpen =
              mondays.length > 0 && mondays.every((day) => open.has(day));
            const name = strings.monthsLong[month.month] ?? "";
            return (
              <button
                aria-expanded={allOpen}
                aria-label={
                  allOpen
                    ? strings.map.closeWeeks(name)
                    : strings.map.openWeeks(name)
                }
                className={cn(
                  "planner-yl planner-ml",
                  month.current && "is-now",
                )}
                data-month={month.month}
                key={month.month}
                type="button"
                onClick={() =>
                  setOpen((current) =>
                    plannerToggleMonthWeeks(current, mondays),
                  )
                }
              >
                {strings.months[month.month]}
              </button>
            );
          })}
          {months.map((month) => (
            <fieldset
              aria-label={strings.map.weeksOf(
                strings.monthsLong[month.month] ?? "",
              )}
              className="planner-wstrip"
              key={month.month}
            >
              {month.weeks.map((week) => {
                const lines = [
                  shortDay(week.monday, strings),
                  ...plannerCellLines(
                    week.monday,
                    currentWeek,
                    week.record,
                    plannerMapIsEmpty(week.goals)
                      ? 0
                      : plannerPillars.reduce(
                          (sum, pillar) =>
                            sum + week.goals.byPillar[pillar].length,
                          week.goals.loose.length,
                        ),
                    strings,
                  ),
                ];
                return (
                  <button
                    aria-label={lines.join(", ")}
                    aria-pressed={open.has(week.monday)}
                    className="planner-wchip"
                    data-kind={week.kind}
                    data-testid="planner-week-cell"
                    key={week.monday}
                    title={lines.join("\n")}
                    type="button"
                    onClick={() => toggleWeek(week.monday)}
                  >
                    <b>{strings.weekCode(week.number)}</b>
                  </button>
                );
              })}
            </fieldset>
          ))}
          {rows.map((row) => (
            <Fragment key={row.pillar ?? "none"}>
              {!follow && (
                <div
                  className={cn(
                    "planner-tl-label planner-tl-top",
                    plannerPillarClass(row.pillar),
                  )}
                  style={{ gridRow: `span ${anyOpen ? 3 : 2}` }}
                >
                  <span className="planner-tl-name">
                    <i aria-hidden="true" className="planner-dot" />
                    {rowName(row)}
                  </span>
                  {row.year.map((goal) => (
                    <button
                      className="planner-tl-year"
                      data-testid="planner-goal"
                      key={goal.id}
                      title={plannerGoalText(goal)}
                      type="button"
                      onClick={() => onEdit({ kind: "edit", goal })}
                    >
                      {plannerGoalParts(goal).head}
                    </button>
                  ))}
                  {row.year.length === 0 && row.pillar && (
                    <button
                      aria-label={`${strings.editor.add} · ${rowName(row)}`}
                      className="planner-u planner-u-add"
                      title={`${strings.editor.add} · ${rowName(row)}`}
                      type="button"
                      onClick={() => onEdit(yearAdd(row.pillar))}
                    >
                      <PlusIcon aria-hidden="true" className="size-3.5" />
                    </button>
                  )}
                </div>
              )}
              {row.quarters.map((quarter) =>
                cell(row, `q${quarter.quarter}`, quarter.goals, {
                  strong: true,
                  span: true,
                  top: true,
                  add: {
                    kind: "new",
                    level: "quarter",
                    periodStart: quarter.start,
                    pillar: row.pillar,
                  },
                }),
              )}
              {row.months.map((month) =>
                cell(row, `m${month.month}`, month.goals, {
                  current: month.current,
                  add: {
                    kind: "new",
                    level: "month",
                    periodStart: month.start,
                    pillar: row.pillar,
                  },
                }),
              )}
              {anyOpen &&
                row.months.map((month) => (
                  <div
                    className={cn("planner-yc", plannerPillarClass(row.pillar))}
                    key={`w${month.month}`}
                  >
                    {month.weeks
                      .filter(
                        ({ week, goals }) =>
                          open.has(week.monday) && goals.length > 0,
                      )
                      .map(({ week, goals }) => (
                        <div className="planner-tl-week" key={week.monday}>
                          <Link
                            aria-label={strings.map.openWeek(
                              strings.week(week.number),
                            )}
                            className={cn(
                              "planner-yl planner-wl",
                              week.kind === "now" && "is-now",
                            )}
                            search={{ week: week.monday }}
                            to="/goals"
                          >
                            {strings.weekCode(week.number)}
                          </Link>
                          <Split current={week.kind === "now"} strong={false}>
                            {goals.map(weekUnit)}
                          </Split>
                        </div>
                      ))}
                  </div>
                ))}
            </Fragment>
          ))}
        </div>
      </div>
      <TaskPop
        currentWeek={currentWeek}
        goal={popGoal}
        map={map}
        strings={strings}
        today={today}
        onClose={() => setPopGoal(null)}
        onEdit={(goal) => {
          setPopGoal(null);
          onEdit({ kind: "edit", goal });
        }}
      />
    </div>
  );
}
