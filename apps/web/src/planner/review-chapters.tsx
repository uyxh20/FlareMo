// Fork: the review's chapters (review-page.tsx): the tiles over the week's
// two parts and the periods closing with it, and a period's chapter.

import {
  type PlannerPeriodLevel,
  type PlannerReviewResponse,
  plannerPeriodLabel,
  plannerPeriodsClosingWith,
  plannerPeriodWeeks,
} from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { QueryErrorState } from "@/components/query-error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { plannerWeekNumber, plannerWeekRange } from "./goals-model";
import type { PlannerReviewPart } from "./goals-search";
import type { PlannerGoalsStrings } from "./goals-strings";
import { plannerFetchPeriodReview } from "./period-api";
import { PlannerPeriodChat } from "./period-chat";
import type { PlannerPeriodStrings } from "./period-strings";
import { plannerQueryKeys } from "./query-keys";
import type { PlannerBackState, PlannerForwardState } from "./review-model";

/** A chapter of the review: the week's two parts, and the periods closing with it. */
export type Chapter =
  | { id: "back" }
  | { id: "forward" }
  | {
      id: PlannerPeriodLevel;
      level: PlannerPeriodLevel;
      period: string;
      label: string;
      weeks: number;
      done: boolean;
    };

/** The periods closing with the reviewed week, as chapters, biggest last. */
export function periodChapters(
  reviewWeek: string,
  done: ReadonlyMap<string, boolean>,
): Chapter[] {
  return plannerPeriodsClosingWith(reviewWeek).map((entry) => ({
    id: entry.level,
    level: entry.level,
    period: entry.period_start,
    label: plannerPeriodLabel(entry.level, entry.period_start),
    weeks: plannerPeriodWeeks(entry.level, entry.period_start).length,
    done: done.get(`${entry.level}:${entry.period_start}`) ?? false,
  }));
}

export function ReviewSkeleton() {
  return (
    <div
      className="flex flex-col gap-4 py-2"
      data-testid="planner-review-loading"
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Skeleton className="h-[480px]" />
        <Skeleton className="h-[480px]" />
      </div>
    </div>
  );
}

/** The chapters of the review, each with where it stands; the open one is outlined. */
export function Chapters({
  chapters,
  part,
  review,
  back,
  forward,
  step,
  lookBackDone,
  strings,
  periodStrings,
}: {
  chapters: readonly Chapter[];
  part: PlannerReviewPart;
  review: PlannerReviewResponse;
  back: PlannerBackState;
  forward: PlannerForwardState;
  step: number;
  lookBackDone: boolean;
  strings: PlannerGoalsStrings;
  periodStrings: PlannerPeriodStrings;
}) {
  const current = chapters.findIndex((chapter) => chapter.id === part);
  // The chapters run in order: the ones after the open chapter wait their turn.
  const open = chapters.findIndex((chapter) =>
    chapter.id === "back"
      ? !lookBackDone
      : chapter.id === "forward"
        ? !review.look_forward_done_at
        : !chapter.done,
  );
  const last = Math.max(current, open === -1 ? chapters.length : open);
  return (
    <nav
      aria-label={strings.review.parts}
      className="sticky top-0 z-10 -mx-1 grid grid-cols-2 gap-1.5 bg-background px-1 py-2 sm:grid-cols-[repeat(var(--chapters),minmax(0,1fr))] sm:gap-2.5"
      style={{ "--chapters": chapters.length } as CSSProperties}
    >
      {chapters.map((chapter, index) => (
        <ChapterTile
          back={back}
          chapter={chapter}
          current={index === current}
          forward={forward}
          key={chapter.id}
          lookBackDone={lookBackDone}
          periodStrings={periodStrings}
          reachable={index <= last}
          review={review}
          stacked={chapters.length > 3}
          step={step}
          strings={strings}
        />
      ))}
    </nav>
  );
}

/** One chapter's tile: its name, its span, and where it stands. */
export function ChapterTile({
  chapter,
  current,
  reachable,
  review,
  back,
  forward,
  step,
  lookBackDone,
  stacked,
  strings,
  periodStrings,
}: {
  chapter: Chapter;
  current: boolean;
  reachable: boolean;
  /** Four or five tiles in a row: the state goes under the name, as on a phone. */
  stacked: boolean;
  review: PlannerReviewResponse;
  back: PlannerBackState;
  forward: PlannerForwardState;
  step: number;
  lookBackDone: boolean;
  strings: PlannerGoalsStrings;
  periodStrings: PlannerPeriodStrings;
}) {
  const text = strings.review;
  const tile = `grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 rounded-xl border border-border bg-card px-2.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${stacked ? "sm:gap-x-3 sm:px-3.5" : "sm:flex sm:gap-3.5 sm:px-4"} sm:py-3 aria-[current=step]:border-brand-500 aria-[current=step]:bg-brand-500/[0.07] aria-[current=step]:shadow-[inset_0_0_0_1px_var(--color-brand-500)] aria-disabled:opacity-60`;
  const arrow =
    "row-span-2 grid size-7 flex-none place-items-center rounded-[10px] bg-muted text-sm sm:size-[34px] sm:text-[17px] in-aria-[current=step]:bg-brand-500 in-aria-[current=step]:text-white";
  // "Week 42 · 12 – 18 Oct", or "W42 · 12 – 18 Oct" where the tile is narrow.
  const weekLine = (monday: string) => {
    const number = plannerWeekNumber(monday);
    const range = plannerWeekRange(monday, strings);
    if (stacked) return `${strings.weekCode(number)} · ${range}`;
    return (
      <>
        <span className="sm:hidden">{`${strings.weekCode(number)} · ${range}`}</span>
        <span className="max-sm:hidden">{`${strings.week(number)} · ${range}`}</span>
      </>
    );
  };
  let mark: string;
  let name: string;
  let line: ReactNode;
  let state: ReactNode;
  if (chapter.id === "back") {
    mark = "←";
    name = text.lookBack;
    line = weekLine(review.review_week);
    state = lookBackDone ? (
      <span className="text-success">✓ {text.done}</span>
    ) : back.stage !== "start" ? (
      text.inProgress
    ) : (
      text.toDo
    );
  } else if (chapter.id === "forward") {
    mark = "→";
    name = text.lookForward;
    line = weekLine(review.plan_week);
    state = review.look_forward_done_at ? (
      <span className="text-success">✓ {text.saved}</span>
    ) : forward.seen ? (
      text.stepOf(step, 4)
    ) : (
      text.toDo
    );
  } else {
    mark = periodStrings.levels[chapter.level].slice(0, 1);
    name = chapter.label;
    line = `${periodStrings.levels[chapter.level]} · ${periodStrings.weeks(chapter.weeks)}`;
    state = chapter.done ? (
      <span className="text-success">✓ {text.saved}</span>
    ) : (
      text.toDo
    );
  }
  const body = (
    <>
      <span aria-hidden="true" className={arrow}>
        {mark}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold sm:text-base">{name}</span>
        <span className="block truncate text-xs text-muted-foreground sm:text-[13px]">
          {line}
        </span>
      </span>
      <span
        className={`col-start-2 text-xs whitespace-nowrap text-muted-foreground ${stacked ? "" : "sm:ml-auto"}`}
      >
        {state}
      </span>
    </>
  );
  const testId = `planner-review-chapter-${chapter.id}`;
  if (!reachable) {
    return (
      <span aria-disabled="true" className={tile} data-testid={testId}>
        {body}
      </span>
    );
  }
  return (
    <Link
      aria-current={current ? "step" : undefined}
      className={tile}
      data-testid={testId}
      search={
        chapter.id === "forward"
          ? { part: "forward", step }
          : { part: chapter.id }
      }
      to="/review"
    >
      {body}
    </Link>
  );
}

/** A month, quarter or year closing with the reviewed week: the weekly chat over it. */
export function PeriodChapter({
  chapter,
  next,
  strings,
  today,
  onSaved,
}: {
  chapter: Extract<Chapter, { level: PlannerPeriodLevel }>;
  next: { label: string; go: () => void };
  strings: PlannerPeriodStrings;
  today: string;
  onSaved: () => void;
}) {
  const query = useQuery({
    queryKey: plannerQueryKeys.periodReview(
      today,
      chapter.level,
      chapter.period,
    ),
    queryFn: () =>
      plannerFetchPeriodReview({
        today,
        level: chapter.level,
        period: chapter.period,
      }),
    // Like the week's: the chat keeps its own state once loaded.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const period = query.data;
  if (!period && query.isError) {
    return (
      <QueryErrorState
        className="min-h-56"
        isRetrying={query.isRefetching}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!period) {
    return (
      <div
        className="flex flex-col gap-3 py-2"
        data-testid="planner-period-loading"
      >
        <Skeleton className="h-12" />
        <Skeleton className="h-[420px]" />
      </div>
    );
  }
  return (
    <PlannerPeriodChat
      key={`${period.level}:${period.period_start}`}
      next={next}
      period={period}
      strings={strings}
      today={today}
      onSaved={onSaved}
    />
  );
}
