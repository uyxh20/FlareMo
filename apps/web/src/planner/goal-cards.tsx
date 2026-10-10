import type {
  PlannerBoardResponse,
  PlannerCockpitWeek,
  PlannerPillar,
} from "@flaremo/contracts";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import {
  plannerGoalProgress,
  plannerGoalSlots,
  plannerGoalText,
  plannerWeekNumber,
  plannerWeekRange,
} from "./goals-model";
import {
  type PlannerGoalsStrings,
  usePlannerGoalsStrings,
} from "./goals-strings";
import "./goals.css";

// The week's goal cards above the cockpit board (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): one card per weekly goal, coloured by
// its objective, with how many of its tasks are done; a dashed card for an
// objective with no goal this week. Clicking a card focuses its goal: the other
// cards and every task that does not serve it fade back until it is clicked
// again or Escape is pressed (the page owns that state).

/** The pillar class that colours an element and its children. */
export function plannerPillarClass(pillar: PlannerPillar | null): string {
  return pillar ? `planner-p-${pillar}` : "";
}

/** "● Work", with the long name on wide screens and the short one on narrow ones. */
export function PlannerPillarLabel({
  pillar,
  strings,
  suffix = "",
  short = false,
  className,
}: {
  pillar: PlannerPillar | null;
  strings: PlannerGoalsStrings;
  /** Text after the name, like " · weekly goal". */
  suffix?: string;
  /** Always the short name. */
  short?: boolean;
  className?: string;
}) {
  const long = pillar ? strings.pillar[pillar] : strings.noPillar;
  const brief = pillar ? strings.pillarShort[pillar] : strings.noPillar;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-foreground",
        plannerPillarClass(pillar),
        className,
      )}
    >
      <i aria-hidden="true" className="planner-dot" />
      {short ? (
        <span className="truncate">
          {brief}
          {suffix}
        </span>
      ) : (
        <>
          <span className="truncate max-sm:hidden">
            {long}
            {suffix}
          </span>
          <span className="truncate sm:hidden">
            {brief}
            {suffix}
          </span>
        </>
      )}
    </span>
  );
}

// Save week in the review sends the person to the cockpit; the cards that just
// landed glow once. Both pages run in the same tab, so a timestamp is enough.
let freshUntil = 0;

/** Marks the cockpit's goal cards as just saved, for the next few seconds. */
export function plannerMarkWeekFresh(now = Date.now()): void {
  freshUntil = now + 5_000;
}

/** Whether the goal cards should glow as just saved; reading it clears it. */
export function plannerTakeWeekFresh(now = Date.now()): boolean {
  const fresh = now < freshUntil;
  freshUntil = 0;
  return fresh;
}

export function PlannerGoalCards({
  week,
  board,
  focus,
  onFocus,
  fresh = false,
}: {
  week: PlannerCockpitWeek;
  board: Pick<PlannerBoardResponse, "columns">;
  /** The goal in focus, or null. */
  focus: string | null;
  onFocus: (goalId: string | null) => void;
  /** The week was just saved: the cards glow once. */
  fresh?: boolean;
}) {
  const strings = usePlannerGoalsStrings();
  const slots = plannerGoalSlots(week.goals);
  const many = slots.length > 4;
  const style = { "--planner-n": Math.min(slots.length, 6) } as CSSProperties;

  return (
    <section aria-label={strings.cockpit.goals} className="flex flex-col gap-2">
      <p className="px-1 text-xs text-muted-foreground tabular-nums">
        {strings.cockpit.weekLine(
          strings.week(plannerWeekNumber(week.start)),
          plannerWeekRange(week.start, strings),
        )}
      </p>
      <div
        className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-[repeat(var(--planner-n),minmax(0,1fr))]"
        data-testid="planner-goal-cards"
        style={style}
      >
        {slots.map((slot) => {
          if (slot.kind === "empty") {
            return (
              <div
                className={cn(
                  "planner-goal-card flex min-h-0 flex-col gap-1.5 rounded-xl px-3 py-2.5 sm:min-h-28 sm:gap-2.5 sm:px-4 sm:py-3.5 motion-safe:transition-opacity",
                  plannerPillarClass(slot.pillar),
                  focus !== null && "opacity-30",
                )}
                data-empty=""
                key={`empty-${slot.pillar}`}
              >
                <PlannerPillarLabel
                  pillar={slot.pillar}
                  short={many}
                  strings={strings}
                />
                <span className="text-sm text-muted-foreground">
                  {strings.cockpit.noGoal}
                </span>
              </div>
            );
          }
          const { goal } = slot;
          const progress = plannerGoalProgress(goal.id, board);
          const pressed = focus === goal.id;
          return (
            <button
              aria-pressed={pressed}
              className={cn(
                "planner-goal-card flex min-h-0 cursor-pointer flex-col gap-1.5 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-28 sm:gap-2.5 sm:px-4 sm:py-3.5 motion-safe:transition-[opacity,transform] motion-safe:duration-150 motion-safe:hover:-translate-y-px",
                plannerPillarClass(slot.pillar),
                focus !== null && !pressed && "opacity-30",
                fresh && "planner-fresh",
              )}
              data-testid="planner-goal-card"
              key={goal.id}
              type="button"
              onClick={() => onFocus(pressed ? null : goal.id)}
            >
              <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                <PlannerPillarLabel
                  pillar={slot.pillar}
                  short={many}
                  strings={strings}
                />
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {progress.total
                    ? `${progress.done}/${progress.total}`
                    : strings.cockpit.noTasks}
                </span>
              </span>
              <span className="line-clamp-4 text-[13.5px] leading-snug font-medium text-foreground sm:line-clamp-none sm:text-[15px]">
                {plannerGoalText(goal)}
              </span>
              <span aria-hidden="true" className="planner-goal-bar mt-auto">
                <i
                  style={{
                    width: `${progress.total ? Math.round((100 * progress.done) / progress.total) : 0}%`,
                  }}
                />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
