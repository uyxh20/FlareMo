import {
  type PlannerGoalDto,
  type PlannerPillar,
  plannerPillars,
} from "@flaremo/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  Fragment,
  type ReactNode,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  plannerCreateTaskRequest,
  plannerErrorMessage,
  plannerFetchBoard,
  plannerUpdateTaskRequest,
} from "./api";
import { plannerCardFromTask } from "./board-model";
import { plannerPillarClass } from "./goal-cards";
import type { PlannerGoalEditorTarget } from "./goal-editor";
import {
  plannerCellLines,
  plannerGoalText,
  plannerWeekNumber,
  plannerWeekRange,
} from "./goals-model";
import type { PlannerGoalsStrings } from "./goals-strings";
import { plannerTaskParamFromId } from "./panel-model";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import {
  type PlannerMapGoals,
  type PlannerMapMark,
  type PlannerMapWeek,
  type PlannerYearMapData,
  plannerGoalTasks,
  plannerMapInitialWeeks,
  plannerMapIsEmpty,
  plannerMapMark,
  plannerMapPath,
  plannerToggleMonthWeeks,
} from "./year-map-model";

// The Year map (fork-owned add-on, docs/planning-cockpit-goals-review.md): the
// Goals page's year. One grid: a time column, then one column per objective.
// The north star spans the top; the year and quarter goals are the coloured
// cards; months and weeks are plain cards under them. Each month folds out its
// weeks; a weekly goal opens a pop-up with its tasks and the goals above it.
// Picking an objective follows it: its column widens and the others shrink to
// dots, which is how a phone opens the map.

type Edit = (target: PlannerGoalEditorTarget) => void;

const PHONE = "(max-width: 640px)";

function initialFollow(): PlannerPillar | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia(PHONE).matches ? "work" : null;
}

export function PlannerYearMap({
  map,
  currentWeek,
  today,
  strings,
  onEdit,
}: {
  map: PlannerYearMapData;
  currentWeek: string;
  today: string;
  strings: PlannerGoalsStrings;
  onEdit: Edit;
}) {
  const [follow, setFollow] = useState<PlannerPillar | null>(initialFollow);
  const [open, setOpen] = useState<Set<string>>(() =>
    plannerMapInitialWeeks(map),
  );
  const [popGoal, setPopGoal] = useState<PlannerGoalDto | null>(null);

  const board = useQuery({
    queryKey: plannerQueryKeys.goalsBoard(today),
    queryFn: () => plannerFetchBoard({ today, doneDays: 366 }),
    staleTime: 30_000,
  });

  const progress = (goal: PlannerGoalDto) => {
    const tasks = plannerGoalTasks(goal.id, board.data);
    return {
      total: tasks.length,
      done: tasks.filter((task) => task.column === "done").length,
    };
  };

  const toggleWeek = (monday: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(monday)) next.delete(monday);
      else next.add(monday);
      return next;
    });

  const style: CSSProperties | undefined = follow
    ? {
        gridTemplateColumns: `44px ${plannerPillars
          .map((pillar) => (pillar === follow ? "minmax(0, 1fr)" : "18px"))
          .join(" ")}`,
      }
    : undefined;

  const cell = (pillar: PlannerPillar, children: ReactNode) => (
    <div
      className={cn(
        "planner-yc",
        plannerPillarClass(pillar),
        follow === pillar && "is-on",
      )}
      key={pillar}
    >
      {children}
    </div>
  );

  /** One period's row of cards, plus a row for its goals with no objective. */
  const periodRow = (
    label: ReactNode,
    goals: PlannerMapGoals,
    strong: boolean,
    current: boolean,
    add: (pillar: PlannerPillar | null) => PlannerGoalEditorTarget,
  ) => (
    <>
      {label}
      {plannerPillars.map((pillar) =>
        cell(
          pillar,
          goals.byPillar[pillar].length ? (
            goals.byPillar[pillar].map((goal) => (
              <MapUnit
                current={current}
                goal={goal}
                key={goal.id}
                mark={plannerMapMark(goal)}
                strings={strings}
                strong={strong}
                onClick={() => onEdit({ kind: "edit", goal })}
              />
            ))
          ) : (
            <button
              aria-label={`${strings.editor.add} · ${strings.pillar[pillar]}`}
              className="planner-u planner-u-add"
              title={`${strings.editor.add} · ${strings.pillar[pillar]}`}
              type="button"
              onClick={() => onEdit(add(pillar))}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
            </button>
          ),
        ),
      )}
      {goals.loose.length > 0 && (
        <>
          <span />
          <div className="planner-span planner-loose">
            {goals.loose.map((goal) => (
              <MapUnit
                current={current}
                goal={goal}
                key={goal.id}
                mark={plannerMapMark(goal)}
                strings={strings}
                strong={strong}
                onClick={() => onEdit({ kind: "edit", goal })}
              />
            ))}
          </div>
        </>
      )}
    </>
  );

  const themeRow = (
    label: ReactNode,
    theme: PlannerGoalDto | null,
    add: () => void,
  ) => (
    <>
      {label}
      <div className="planner-qband">
        {theme ? (
          <button
            className="planner-theme"
            title={strings.editor.edit(plannerGoalText(theme))}
            type="button"
            onClick={() => onEdit({ kind: "edit", goal: theme })}
          >
            {plannerGoalText(theme)}
          </button>
        ) : (
          <button
            aria-label={strings.editor.add}
            className="planner-theme planner-theme-add"
            title={strings.editor.add}
            type="button"
            onClick={add}
          >
            <PlusIcon aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
    </>
  );

  const weekRows = (week: PlannerMapWeek) => {
    const hasPillarGoal = plannerPillars.some(
      (pillar) => week.goals.byPillar[pillar].length > 0,
    );
    const weekUnit = (goal: PlannerGoalDto) => (
      <MapUnit
        current={week.kind === "now"}
        goal={goal}
        key={goal.id}
        label={strings.map.tasksFor(plannerGoalText(goal))}
        mark={plannerMapMark(goal, progress(goal))}
        strings={strings}
        strong={false}
        onClick={() => setPopGoal(goal)}
      />
    );
    const label = (
      <Link
        aria-label={strings.map.openWeek(strings.week(week.number))}
        className={cn("planner-yl planner-wl", week.kind === "now" && "is-now")}
        search={{ week: week.monday }}
        to="/goals"
      >
        {strings.weekCode(week.number)}
      </Link>
    );
    if (plannerMapIsEmpty(week.goals)) {
      return (
        <Fragment key={week.monday}>
          {label}
          <div className="planner-span planner-loose">
            <span className="planner-u planner-u-empty">
              {week.kind === "future" || week.kind === "now"
                ? strings.map.notPlanned
                : strings.goals.noGoalsSet}
            </span>
          </div>
        </Fragment>
      );
    }
    return (
      <Fragment key={week.monday}>
        {label}
        {hasPillarGoal ? (
          <>
            {plannerPillars.map((pillar) =>
              cell(pillar, week.goals.byPillar[pillar].map(weekUnit)),
            )}
            {week.goals.loose.length > 0 && (
              <>
                <span />
                <div className="planner-span planner-loose">
                  {week.goals.loose.map(weekUnit)}
                </div>
              </>
            )}
          </>
        ) : (
          <div className="planner-span planner-loose">
            {week.goals.loose.map(weekUnit)}
          </div>
        )}
      </Fragment>
    );
  };

  return (
    <div className="flex flex-col gap-3.5">
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
      <div className="overflow-x-auto pb-1">
        <div
          className={cn("planner-ymap", follow && "is-following")}
          data-testid="planner-year-map"
          style={style}
        >
          <span className="planner-yl is-star">{strings.goals.northStar}</span>
          <div className="planner-span">
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
          </div>
          {map.theme && themeRow(<span />, map.theme, () => {})}
          {periodRow(
            <span className="planner-yl is-period">
              {strings.goals.year(map.year)}
            </span>,
            map.goals,
            true,
            false,
            (pillar) => ({
              kind: "new",
              level: "year",
              periodStart: map.start,
              pillar,
            }),
          )}
          {map.quarters.map((quarter) => (
            <Fragment key={quarter.quarter}>
              {themeRow(
                <span className="planner-yl is-period planner-qlab">
                  {strings.goals.quarter(quarter.quarter)}
                </span>,
                quarter.theme,
                () =>
                  onEdit({
                    kind: "new",
                    level: "quarter",
                    periodStart: quarter.start,
                    pillar: null,
                  }),
              )}
              {periodRow(<span />, quarter.goals, true, false, (pillar) => ({
                kind: "new",
                level: "quarter",
                periodStart: quarter.start,
                pillar,
              }))}
              {quarter.months.map((month) => {
                const mondays = month.weeks.map((week) => week.monday);
                const allOpen =
                  mondays.length > 0 && mondays.every((day) => open.has(day));
                const name = strings.monthsLong[month.month] ?? "";
                return (
                  <Fragment key={month.month}>
                    {periodRow(
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
                        type="button"
                        onClick={() =>
                          setOpen((current) =>
                            plannerToggleMonthWeeks(current, mondays),
                          )
                        }
                      >
                        {strings.months[month.month]}
                      </button>,
                      month.goals,
                      false,
                      month.current,
                      (pillar) => ({
                        kind: "new",
                        level: "month",
                        periodStart: month.start,
                        pillar,
                      }),
                    )}
                    <span />
                    <fieldset
                      aria-label={strings.map.weeksOf(name)}
                      className="planner-span planner-wstrip"
                    >
                      {month.weeks.map((week) => {
                        const lines = plannerCellLines(
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
                        );
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
                            <span>{shortDay(week.monday, strings)}</span>
                          </button>
                        );
                      })}
                    </fieldset>
                    {month.weeks
                      .filter((week) => open.has(week.monday))
                      .map(weekRows)}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <TaskPop
        goal={popGoal}
        map={map}
        strings={strings}
        today={today}
        currentWeek={currentWeek}
        onClose={() => setPopGoal(null)}
        onEdit={(goal) => {
          setPopGoal(null);
          onEdit({ kind: "edit", goal });
        }}
      />
    </div>
  );
}

/** "12 Oct": a week's Monday. */
function shortDay(monday: string, strings: PlannerGoalsStrings): string {
  const range = plannerWeekRange(monday, strings);
  return range.split("–")[0]?.trim() ?? range;
}

function markText(
  mark: PlannerMapMark,
  strings: PlannerGoalsStrings,
): { text: string; label: string } {
  switch (mark.kind) {
    case "met":
      return { text: "✓", label: strings.result.met };
    case "partial":
      return { text: "◐", label: strings.result.partial };
    case "missed":
      return { text: "✕", label: strings.result.missed };
    case "contested":
      return { text: "⚑", label: strings.status.contested };
    case "draft":
      return { text: strings.status.draft, label: strings.status.draft };
    case "closed":
      return { text: "—", label: strings.status.closed };
    case "tasks":
      return {
        text: `${mark.done}/${mark.total}`,
        label: strings.map.tasksDone(mark.done, mark.total),
      };
  }
}

/** A goal on the map: a dot, its text in up to two lines, and its mark. */
function MapUnit({
  goal,
  mark,
  strong,
  current,
  label,
  strings,
  onClick,
}: {
  goal: PlannerGoalDto;
  mark: PlannerMapMark | null;
  strong: boolean;
  current: boolean;
  label?: string;
  strings: PlannerGoalsStrings;
  onClick: () => void;
}) {
  const text = plannerGoalText(goal);
  const shown = mark ? markText(mark, strings) : null;
  const hint = [text, shown?.label, goal.note].filter(Boolean).join("\n");
  return (
    <button
      aria-label={[label ?? strings.editor.edit(text), shown?.label]
        .filter(Boolean)
        .join(", ")}
      className={cn("planner-u", plannerPillarClass(goal.pillar))}
      data-current={current || undefined}
      data-strong={strong || undefined}
      data-testid="planner-goal"
      title={hint}
      type="button"
      onClick={onClick}
    >
      <i aria-hidden="true" className="planner-dot" />
      <span className="planner-u-t">{text}</span>
      {shown && (
        <span aria-hidden="true" className="planner-u-m" data-kind={mark?.kind}>
          {shown.text}
        </span>
      )}
    </button>
  );
}

/** A weekly goal's pop-up: the goals above it, its tasks, and a way to add one. */
function TaskPop({
  goal,
  map,
  today,
  currentWeek,
  strings,
  onClose,
  onEdit,
}: {
  goal: PlannerGoalDto | null;
  map: PlannerYearMapData;
  today: string;
  currentWeek: string;
  strings: PlannerGoalsStrings;
  onClose: () => void;
  onEdit: (goal: PlannerGoalDto) => void;
}) {
  return (
    <Dialog
      open={goal !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "planner-pop max-h-[calc(100dvh-2rem)] gap-3.5 overflow-y-auto sm:max-w-md",
          goal && plannerPillarClass(goal.pillar),
        )}
      >
        {goal && (
          <TaskPopBody
            currentWeek={currentWeek}
            goal={goal}
            key={goal.id}
            map={map}
            strings={strings}
            today={today}
            onEdit={onEdit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskPopBody({
  goal,
  map,
  today,
  currentWeek,
  strings,
  onEdit,
}: {
  goal: PlannerGoalDto;
  map: PlannerYearMapData;
  today: string;
  currentWeek: string;
  strings: PlannerGoalsStrings;
  onEdit: (goal: PlannerGoalDto) => void;
}) {
  const cockpit = usePlannerStrings();
  const queryClient = useQueryClient();
  const board = useQuery({
    queryKey: plannerQueryKeys.goalsBoard(today),
    queryFn: () => plannerFetchBoard({ today, doneDays: 366 }),
    staleTime: 30_000,
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const monday = goal.period_start ?? currentWeek;
  const tasks = plannerGoalTasks(goal.id, board.data);
  const path = plannerMapPath(map, goal).filter(
    (step) => step.goals.length > 0,
  );
  const canAdd = monday >= currentWeek;
  const pillarName = goal.pillar
    ? strings.pillar[goal.pillar]
    : strings.noPillar;
  const head = [
    pillarName,
    strings.weekCode(plannerWeekNumber(monday)),
    plannerWeekRange(monday, strings),
  ].join(" · ");

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const response = await plannerCreateTaskRequest({ title, today });
      const created = plannerCardFromTask(response.task, response.plan);
      await plannerUpdateTaskRequest(created.id, { today, goal_id: goal.id });
      setDraft("");
      toast.success(strings.map.taskAdded);
    } catch (error) {
      toast.error(
        plannerErrorMessage(
          error,
          strings.map.addTaskFailed,
          strings.map.addTaskFailed,
        ),
      );
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.boards,
      });
    }
  };

  return (
    <>
      <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <i aria-hidden="true" className="planner-dot" />
        {head}
      </span>
      <DialogTitle className="pr-8 text-lg leading-snug">
        {plannerGoalText(goal)}
      </DialogTitle>
      {goal.title.trim() && goal.lines.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {goal.lines.map((line) => (
            <li className={cn(line.struck && "line-through")} key={line.text}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
      {goal.note && (
        <DialogDescription className="text-sm">{goal.note}</DialogDescription>
      )}
      {path.length > 0 && (
        <div className="planner-pop-path">
          {path.map((step) => (
            <div key={step.level}>
              <span className="font-mono text-[11px] text-muted-foreground uppercase">
                {step.level === "year"
                  ? strings.goals.year(map.year)
                  : step.level === "quarter"
                    ? strings.goals.quarter(step.quarter)
                    : strings.months[step.month]}
              </span>
              <span>{step.goals.map(plannerGoalText).join(" · ")}</span>
            </div>
          ))}
        </div>
      )}
      <ul aria-label={strings.goals.weeklyGoals} className="flex flex-col">
        {tasks.length === 0 && (
          <li className="py-2 text-sm text-muted-foreground">
            {board.isPending ? "…" : strings.map.noTasks}
          </li>
        )}
        {tasks.map(({ card, column }) => (
          <li className="border-b border-border last:border-b-0" key={card.id}>
            <Link
              className="flex items-center gap-3 py-2 text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              search={{ task: plannerTaskParamFromId(card.id) }}
              to="/cockpit"
            >
              <span
                className={cn(
                  "min-w-0 flex-1",
                  column === "done" && "text-muted-foreground line-through",
                )}
              >
                {card.title}
              </span>
              <span className="planner-pop-col" data-column={column}>
                {cockpit.column[column]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {canAdd && (
        <form className="flex gap-2" onSubmit={add}>
          <Input
            aria-label={strings.map.newTask}
            disabled={busy}
            maxLength={500}
            placeholder={strings.map.newTask}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            disabled={busy || !draft.trim()}
            type="submit"
            variant="outline"
          >
            <PlusIcon data-icon="inline-start" />
            {strings.map.addTask}
          </Button>
        </form>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => onEdit(goal)}>
          {strings.map.editGoal}
        </Button>
        <Button render={<Link to="/cockpit" />}>
          {strings.map.openCockpit}
        </Button>
      </div>
    </>
  );
}
