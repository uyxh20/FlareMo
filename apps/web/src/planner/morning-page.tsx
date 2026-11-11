import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerColumn,
  PlannerMorningResponse,
} from "@flaremo/contracts";
import { plannerCardColumn } from "@flaremo/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TIMELINE_SEARCH } from "@/lib/timeline-search";
import { cn } from "@/lib/utils";
import { plannerFetchBoard, plannerUpdateTaskRequest } from "./api";
import { plannerPillarClass } from "./goal-cards";
import {
  plannerFetchMorning,
  plannerMorningDismissRequest,
  plannerMorningLineRequest,
  plannerMorningMemory,
} from "./morning-api";
import {
  type PlannerMorningGoal,
  type PlannerMorningTask,
  plannerMorningDateLabel,
  plannerMorningDue,
  plannerMorningGoals,
  plannerMorningGoalsHeading,
  plannerMorningLateLabel,
  plannerMorningMeterSteps,
} from "./morning-model";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerToday } from "./use-planner-clock";
import "./goals.css";

// The morning page (fork-owned add-on, docs/fork-customizations.md "Morning
// page"; layout B, chosen by Anon on 11 Nov 2026). The diary opens on it the
// first time each day (morning-entry.tsx); "Start the day" dismisses it for the
// rest of the day and lands on the diary. It shows the date, the day's idea
// line with "Another", the tasks due today or overdue (a tick marks one done
// through the cockpit's own route, so the history archive records it) and the
// week's goals with a five-step meter of their tasks done.
//
// The line is written on the first open of the day and saved, so a reload shows
// the same one. When no model is set up, or it declines, the slot is hidden.

export function PlannerMorningPage() {
  const today = usePlannerToday();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    plannerMorningMemory.markOpened(today);
  }, [today]);

  const morningKey = plannerQueryKeys.morning(today);
  const morning = useQuery({
    queryKey: morningKey,
    queryFn: () => plannerFetchMorning(today),
    retry: false,
  });
  const board = useQuery({
    queryKey: plannerQueryKeys.board(today, false),
    queryFn: () => plannerFetchBoard({ today }),
  });

  // The line: written once, on the first open of the day without one.
  const [writing, setWriting] = useState(false);
  const asked = useRef<string | null>(null);
  const data = morning.data;
  useEffect(() => {
    if (!data || data.line || !data.can_write || asked.current === today) {
      return;
    }
    asked.current = today;
    setWriting(true);
    plannerMorningLineRequest(today)
      .then((next) => queryClient.setQueryData(morningKey, next))
      .catch(() => undefined)
      .finally(() => setWriting(false));
  }, [data, today, queryClient, morningKey]);

  const another = async () => {
    const current = data?.line;
    if (!current || writing) return;
    setWriting(true);
    try {
      const next = await plannerMorningLineRequest(today, current.id);
      queryClient.setQueryData<PlannerMorningResponse>(morningKey, next);
      if (next.line?.id === current.id) {
        toast("No new line this time. Try again in a moment.");
      }
    } catch {
      toast("No new line this time. Try again in a moment.");
    } finally {
      setWriting(false);
    }
  };

  const [starting, setStarting] = useState(false);
  const startTheDay = async () => {
    setStarting(true);
    plannerMorningMemory.markDismissed(today);
    try {
      const next = await plannerMorningDismissRequest(
        today,
        data?.line?.id ?? null,
      );
      queryClient.setQueryData(morningKey, next);
    } catch {
      // The browser remembers it for today; the server will hear tomorrow.
    }
    void navigate({ to: "/", search: TIMELINE_SEARCH, replace: true });
  };

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 py-10 text-center text-foreground sm:px-6">
      <span className="text-sm text-muted-foreground">
        {plannerMorningDateLabel(today)}
      </span>
      <IdeaLine
        response={data}
        loading={morning.isPending}
        writing={writing}
        onAnother={() => void another()}
      />
      {board.data ? (
        <MorningPanels board={board.data} today={today} />
      ) : (
        <div
          aria-hidden
          className="grid w-full max-w-[620px] gap-3.5 sm:grid-cols-2"
        >
          <div className="h-32 rounded-2xl border border-border bg-card" />
          <div className="h-32 rounded-2xl border border-border bg-card" />
        </div>
      )}
      <Button
        className="h-10 rounded-full px-5 text-sm"
        disabled={starting}
        onClick={() => void startTheDay()}
      >
        Start the day
      </Button>
    </main>
  );
}

function IdeaLine({
  response,
  loading,
  writing,
  onAnother,
}: {
  response: PlannerMorningResponse | undefined;
  loading: boolean;
  writing: boolean;
  onAnother: () => void;
}) {
  const line = response?.line ?? null;
  if (line) {
    return (
      <div className="flex max-w-[34rem] flex-col items-center gap-3">
        <p
          aria-live="polite"
          className={cn(
            "text-[clamp(22px,3vw,28px)] font-semibold leading-tight text-balance motion-safe:transition-opacity",
            writing && "opacity-40",
          )}
          data-testid="morning-line"
        >
          {line.text}
        </p>
        <Button
          className="rounded-full text-sm"
          disabled={writing}
          size="sm"
          variant="outline"
          onClick={onAnother}
        >
          {writing ? "Writing…" : "Another"}
        </Button>
      </div>
    );
  }
  // Still asking, or writing the first line of the day.
  if (loading || writing) {
    return (
      <p
        aria-live="polite"
        className="max-w-[34rem] text-[clamp(22px,3vw,28px)] font-semibold leading-tight text-muted-foreground motion-safe:animate-pulse"
      >
        Writing today's line…
      </p>
    );
  }
  // No model, a refusal or a failure: the slot is hidden.
  return null;
}

function MorningPanels({
  board,
  today,
}: {
  board: PlannerBoardResponse;
  today: string;
}) {
  const queryClient = useQueryClient();
  // Tasks ticked here stay in the list, shown done; the column each came
  // from is kept so an untick puts it back.
  const [ticked, setTicked] = useState<Map<string, PlannerColumn>>(new Map());
  const tickedIds = useMemo(() => new Set(ticked.keys()), [ticked]);
  const due = plannerMorningDue(board, today, tickedIds);
  const goals = plannerMorningGoals(board);

  const toggle = async (task: PlannerMorningTask) => {
    const card = findCard(board, task.id);
    if (!card) return;
    const from = ticked.get(task.id);
    const undo = task.done && from !== undefined;
    const target: PlannerColumn = undo ? from : "done";
    if (!undo) {
      const column = plannerCardColumn(card);
      const back: PlannerColumn =
        column === "backlog" || column === "doing" ? column : "todo";
      setTicked((current) => new Map(current).set(task.id, back));
    }
    try {
      await plannerUpdateTaskRequest(task.id, { today, column: target });
      if (undo) {
        setTicked((current) => {
          const next = new Map(current);
          next.delete(task.id);
          return next;
        });
      }
    } catch {
      toast("That didn't save. Try again.");
    }
    await queryClient.invalidateQueries({ queryKey: plannerQueryKeys.boards });
    await queryClient.invalidateQueries({
      queryKey: plannerQueryKeys.overdue(today),
    });
  };

  return (
    <div className="grid w-full max-w-[620px] gap-3.5 text-left sm:grid-cols-2">
      <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card p-3.5">
        <h2 className="text-sm font-normal text-muted-foreground">Due today</h2>
        {due.length ? (
          due.map((task) => (
            <DueRow
              key={task.id}
              task={task}
              onToggle={() => void toggle(task)}
            />
          ))
        ) : (
          <p className="text-[15px] text-muted-foreground">
            Nothing due. A clear day.
          </p>
        )}
      </section>
      <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card p-3.5">
        <h2 className="text-sm font-normal text-muted-foreground">
          {plannerMorningGoalsHeading(board)}
        </h2>
        {goals.length ? (
          goals.map((goal) => <GoalRow goal={goal} key={goal.id} />)
        ) : (
          <p className="text-[15px] text-muted-foreground">
            No goals set for this week.
          </p>
        )}
      </section>
    </div>
  );
}

function findCard(
  board: PlannerBoardResponse,
  id: string,
): PlannerBoardCard | undefined {
  const { backlog, todo, doing, done, other } = board.columns;
  return [...backlog, ...todo, ...doing, ...done, ...other].find(
    (card) => card.id === id,
  );
}

function DueRow({
  task,
  onToggle,
}: {
  task: PlannerMorningTask;
  onToggle: () => void;
}) {
  const late = plannerMorningLateLabel(task.daysLate);
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-card px-2.5 py-2 text-left text-[15px] hover:bg-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring">
      <input
        checked={task.done}
        className="sr-only"
        type="checkbox"
        onChange={onToggle}
      />
      <span
        aria-hidden
        className={cn(
          "grid size-4 flex-none place-items-center rounded-full border-[1.5px] border-muted-foreground",
          task.done && "border-foreground bg-foreground text-background",
        )}
      >
        {task.done ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          task.done && "text-muted-foreground line-through",
        )}
      >
        {task.title}
      </span>
      {late && !task.done ? (
        <span className="flex-none text-sm text-destructive">{late}</span>
      ) : null}
    </label>
  );
}

function GoalRow({ goal }: { goal: PlannerMorningGoal }) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[auto_1fr_auto] items-center gap-2.5 text-[15px]",
        plannerPillarClass(goal.pillar),
      )}
    >
      <span
        aria-hidden
        className={cn("planner-dot", !goal.pillar && "bg-muted-foreground")}
      />
      <span className="min-w-0 truncate">{goal.title}</span>
      <span
        aria-label={`${goal.done} of ${goal.total} tasks done`}
        className="flex gap-[3px]"
        role="img"
        title={`${goal.done} of ${goal.total} tasks done`}
      >
        {Array.from({ length: plannerMorningMeterSteps }, (_, step) => (
          <i
            className={cn(
              "block size-3 rounded-[3px] border",
              step < goal.filled
                ? "border-foreground bg-foreground"
                : "border-border bg-muted",
            )}
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed five steps
            key={step}
          />
        ))}
      </span>
    </div>
  );
}
