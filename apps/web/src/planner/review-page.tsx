import {
  type PlannerAiOpeningResponse,
  type PlannerBoardCard,
  type PlannerGoalResult,
  type PlannerPillar,
  type PlannerReviewResponse,
  plannerComposeSummaryMemo,
  plannerPillars,
  plannerTodoCap,
} from "@flaremo/contracts";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CalendarCheck2Icon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { QueryErrorState } from "@/components/query-error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { WorkspacePageHeader } from "@/components/workspace/workspace-page-header";
import { cn } from "@/lib/utils";
import { plannerErrorMessage, plannerFetchBoard } from "./api";
import { plannerMarkWeekFresh } from "./goal-cards";
import {
  plannerAiCheckRequest,
  plannerAiCloseRequest,
  plannerAiFailure,
  plannerAiOpeningRequest,
  plannerFetchReview,
  plannerLookBackRequest,
  plannerLookForwardRequest,
  plannerSaveReviewStateRequest,
  plannerStreamCoach,
  plannerStreamMemo,
} from "./goals-api";
import { plannerWeekNumber, plannerWeekRange } from "./goals-model";
import {
  type PlannerGoalsStrings,
  usePlannerGoalsStrings,
} from "./goals-strings";
import { plannerQueryKeys } from "./query-keys";
import { PlannerLookBack } from "./review-back";
import { type PlannerCheck, PlannerLookForward } from "./review-forward";
import {
  type PlannerBackState,
  type PlannerForwardState,
  type PlannerReviewState,
  plannerAddAnswer,
  plannerAddBoardTask,
  plannerAddCoachReply,
  plannerAddNewTask,
  plannerAddProbe,
  plannerAdvance,
  plannerAfterCommit,
  plannerAnswersInput,
  plannerCheckFlags,
  plannerCheckInput,
  plannerCoachMessages,
  plannerCoachMode,
  plannerCommitInput,
  plannerDraftsOf,
  plannerFallbackDrafts,
  plannerLookBackInput,
  plannerMemoDrafts,
  plannerMergeClose,
  plannerMergeOpening,
  plannerNamedGoals,
  plannerNewId,
  plannerOpenQuestions,
  plannerOpenScores,
  plannerPlanFromMemo,
  plannerPlanQuestion,
  plannerPlanSignature,
  plannerPrefillTasks,
  plannerRestoreReviewState,
  plannerStepScore,
  plannerSummaryInput,
  plannerSysOnce,
  plannerTodoCount,
} from "./review-model";
import { PlannerMemoSheet } from "./review-sheet";
import { usePlannerStrings } from "./strings";
import { usePlannerToday } from "./use-planner-clock";
import "./goals.css";

// The weekly review at /weekly-review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): Look back, a chat over the week that
// ends in scores, a question for next Sunday, a verdict and the summary memo;
// then Look forward, which plans the next week's goals and tasks. Both parts can
// be done in any order and left at any point: the page saves where the review
// stands as it goes, and picks it up again on the next visit.
//
// The model drafts answer options, coaches in the chat, drafts the scores and
// writes the memo. Without one the page drafts what it can itself, so the
// review always runs to the end.

const SAVE_DELAY = 800;

export function PlannerReviewPage() {
  const strings = usePlannerGoalsStrings();
  const today = usePlannerToday();
  const query = useQuery({
    queryKey: plannerQueryKeys.review(today),
    queryFn: () => plannerFetchReview({ today }),
    // The page keeps its own state once loaded; a refetch would only overwrite it.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  const review = query.data;

  let content: ReactNode;
  if (!review && query.isError) {
    content = (
      <QueryErrorState
        className="min-h-56"
        isRetrying={query.isRefetching}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (!review) {
    content = <ReviewSkeleton />;
  } else {
    content = (
      <ReviewSession key={review.review_week} review={review} today={today} />
    );
  }

  return (
    <WorkspaceLayout
      maxWidthClass="max-w-[1320px]"
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
            <CalendarCheck2Icon className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />
          }
          maxWidthClass="max-w-[1320px]"
          mobileSheetOpen={mobileSheetOpen}
          setMobileSheetOpen={setMobileSheetOpen}
          sidebarCollapsed={sidebarCollapsed}
          title={strings.review.title}
          toggleSidebarCollapsed={toggleSidebarCollapsed}
        />
      )}
    >
      <div className="flex flex-col gap-3 pb-10" data-testid="planner-review">
        {content}
      </div>
    </WorkspaceLayout>
  );
}

function ReviewSkeleton() {
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

/** The two parts of the review, each with where it stands. */
function Parts({
  part,
  review,
  back,
  forward,
  step,
  lookBackDone,
  strings,
}: {
  part: "back" | "forward";
  review: PlannerReviewResponse;
  back: PlannerBackState;
  forward: PlannerForwardState;
  step: number;
  lookBackDone: boolean;
  strings: PlannerGoalsStrings;
}) {
  const text = strings.review;
  const tile =
    "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 rounded-xl border border-border bg-card px-2.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:flex sm:gap-3.5 sm:px-4 sm:py-3 aria-[current=step]:border-brand-500 aria-[current=step]:bg-brand-500/[0.07] aria-[current=step]:shadow-[inset_0_0_0_1px_var(--color-brand-500)]";
  const arrow =
    "row-span-2 grid size-7 flex-none place-items-center rounded-[10px] bg-muted text-sm sm:size-[34px] sm:text-[17px] in-aria-[current=step]:bg-brand-500 in-aria-[current=step]:text-white";
  // "Week 42 · 12 – 18 Oct", or "W42 · 12 – 18 Oct" where the tile is narrow.
  const weekLine = (monday: string) => {
    const number = plannerWeekNumber(monday);
    const range = plannerWeekRange(monday, strings);
    return (
      <>
        <span className="sm:hidden">{`${strings.weekCode(number)} · ${range}`}</span>
        <span className="max-sm:hidden">{`${strings.week(number)} · ${range}`}</span>
      </>
    );
  };
  const backState = lookBackDone ? (
    <span className="text-success">✓ {text.done}</span>
  ) : back.stage !== "start" ? (
    text.inProgress
  ) : (
    text.toDo
  );
  const forwardState = review.look_forward_done_at ? (
    <span className="text-success">✓ {text.saved}</span>
  ) : forward.seen ? (
    text.stepOf(step, 4)
  ) : (
    text.toDo
  );
  return (
    <nav
      aria-label={text.parts}
      className="sticky top-0 z-10 -mx-1 grid grid-cols-2 gap-1.5 bg-background px-1 py-2 sm:gap-2.5"
    >
      <Link
        aria-current={part === "back" ? "step" : undefined}
        className={tile}
        search={{ part: "back" }}
        to="/weekly-review"
      >
        <span aria-hidden="true" className={arrow}>
          ←
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold sm:text-base">
            {text.lookBack}
          </span>
          <span className="block truncate text-xs text-muted-foreground sm:text-[13px]">
            {weekLine(review.review_week)}
          </span>
        </span>
        <span className="col-start-2 text-xs whitespace-nowrap text-muted-foreground sm:ml-auto">
          {backState}
        </span>
      </Link>
      <Link
        aria-current={part === "forward" ? "step" : undefined}
        className={tile}
        search={{ part: "forward", step }}
        to="/weekly-review"
      >
        <span aria-hidden="true" className={arrow}>
          →
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold sm:text-base">
            {text.lookForward}
          </span>
          <span className="block truncate text-xs text-muted-foreground sm:text-[13px]">
            {weekLine(review.plan_week)}
          </span>
        </span>
        <span className="col-start-2 text-xs whitespace-nowrap text-muted-foreground sm:ml-auto">
          {forwardState}
        </span>
      </Link>
    </nav>
  );
}

function ReviewSession({
  review,
  today,
}: {
  review: PlannerReviewResponse;
  today: string;
}) {
  const strings = usePlannerGoalsStrings();
  const cockpit = usePlannerStrings();
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: "/weekly-review" });
  const search = useSearch({ from: "/weekly-review" });
  const week = review.review_week;

  // --- The review's state, saved as it changes -----------------------------

  const [state, setState] = useState<PlannerReviewState>(() =>
    plannerRestoreReviewState(review.state, review),
  );
  const stateRef = useRef(state);
  const dirty = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const alive = useRef(true);

  const flush = useCallback(
    async (keepalive = false) => {
      window.clearTimeout(saveTimer.current);
      if (!dirty.current) return;
      dirty.current = false;
      const saving = stateRef.current as unknown as Record<string, unknown>;
      // The cached review is what the page starts from when it is opened again
      // (the query never refetches on its own), so it carries the state too:
      // otherwise a second visit would start from the first load's state and
      // save that over this one.
      queryClient.setQueryData<PlannerReviewResponse>(
        plannerQueryKeys.review(today),
        (cached) =>
          cached?.review_week === week ? { ...cached, state: saving } : cached,
      );
      try {
        await plannerSaveReviewStateRequest(week, saving, { keepalive });
      } catch {
        // Saved again with the next change, or when the page is hidden.
        dirty.current = true;
      }
    },
    [queryClient, today, week],
  );

  const update = useCallback(
    (change: (current: PlannerReviewState) => PlannerReviewState) => {
      const next = change(stateRef.current);
      if (next === stateRef.current) return;
      stateRef.current = next;
      setState(next);
      dirty.current = true;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), SAVE_DELAY);
    },
    [flush],
  );
  const setBack = useCallback(
    (change: (back: PlannerBackState) => PlannerBackState) =>
      update((current) => {
        const back = change(current.back);
        return back === current.back ? current : { ...current, back };
      }),
    [update],
  );
  const setForward = useCallback(
    (change: (forward: PlannerForwardState) => PlannerForwardState) =>
      update((current) => {
        const forward = change(current.forward);
        return forward === current.forward ? current : { ...current, forward };
      }),
    [update],
  );

  const coachAbort = useRef<AbortController | null>(null);
  const memoAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush(true);
    };
    const onPageHide = () => void flush(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      coachAbort.current?.abort();
      memoAbort.current?.abort();
      void flush(true);
    };
  }, [flush]);

  const { back, forward } = state;
  const lookBackDone = back.memoSaved || Boolean(review.look_back_done_at);
  const part = search.part ?? (lookBackDone ? "forward" : "back");
  const step = search.step ?? forward.step;
  const drafts = plannerDraftsOf(back, review);
  const failureNote = (kind: "unavailable" | "limited" | "failed") =>
    kind === "limited" ? strings.review.modelLimited : strings.review.modelDown;

  // --- Look back -----------------------------------------------------------

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [live, setLive] = useState<string | null>(null);

  // The coach rests for the rest of the visit once the model has failed twice
  // in a row (the opening counts): every answer would otherwise wait on it.
  const failures = useRef(0);
  const [coachOn, setCoachOn] = useState(review.ai);
  const coachOnRef = useRef(review.ai);
  const modelFailed = (kind: "unavailable" | "limited" | "failed") => {
    if (kind === "limited") return;
    failures.current += 1;
    if (failures.current >= 2 && coachOnRef.current) {
      coachOnRef.current = false;
      setCoachOn(false);
    }
  };

  const runOpening = async () => {
    const base = plannerFallbackDrafts(review);
    let ai: PlannerAiOpeningResponse | null = null;
    let note: string | null = review.ai ? null : strings.review.noModel;
    if (review.ai) {
      try {
        ai = await plannerAiOpeningRequest(week, today);
      } catch (error) {
        const kind = plannerAiFailure(error);
        note = failureNote(kind);
        modelFailed(kind);
      }
    }
    if (!alive.current) return;
    setBack((current) => {
      if (current.stage !== "drafting") return current;
      const noted = note ? plannerSysOnce(current, note) : current;
      return plannerOpenQuestions(noted, review, plannerMergeOpening(base, ai));
    });
  };

  const runClose = async () => {
    const current = stateRef.current.back;
    let next = plannerDraftsOf(current, review);
    let note: string | null = null;
    if (review.ai) {
      try {
        next = plannerMergeClose(
          next,
          await plannerAiCloseRequest(week, {
            today,
            ...plannerAnswersInput(current, review),
          }),
        );
      } catch (error) {
        note = failureNote(plannerAiFailure(error));
      }
    }
    if (!alive.current) return;
    setBack((latest) => {
      if (latest.stage !== "scoring") return latest;
      return plannerOpenScores(
        note ? plannerSysOnce(latest, note) : latest,
        next,
      );
    });
  };

  // A review left while the model was drafting picks up where it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    const stage = stateRef.current.back.stage;
    if (stage === "drafting") void runOpening();
    else if (stage === "scoring") void runClose();
  }, []);

  const advance = () => {
    setBack((current) => plannerAdvance(current, review));
    if (stateRef.current.back.stage === "scoring") void runClose();
  };

  /** One coach reply, streamed into the chat. Null when it did not answer. */
  const coach = async (
    mode: "free" | "force" | "chat",
  ): Promise<{ advance: boolean } | null> => {
    const controller = new AbortController();
    coachAbort.current = controller;
    busyRef.current = true;
    setBusy(true);
    setLive("");
    const result = await plannerStreamCoach(
      week,
      { today, mode, messages: plannerCoachMessages(stateRef.current.back) },
      {
        signal: controller.signal,
        onText: (text) => {
          if (alive.current) setLive(text);
        },
      },
    );
    coachAbort.current = null;
    busyRef.current = false;
    if (!alive.current) return null;
    setBusy(false);
    setLive(null);
    const text = result.text.trim();
    if (result.status === "done" && text) {
      failures.current = 0;
      const forward = result.advance ?? !/\?\s*$/.test(text);
      setBack((current) => plannerAddCoachReply(current, text, forward));
      return { advance: forward };
    }
    if (result.status !== "aborted" && result.status !== "done") {
      modelFailed(result.status);
    }
    if (text) setBack((current) => plannerAddCoachReply(current, text, true));
    if (result.status === "limited") {
      setBack((current) =>
        plannerSysOnce(current, strings.review.modelLimited),
      );
    } else if (result.status === "unavailable") {
      setBack((current) => plannerSysOnce(current, strings.review.modelDown));
    } else if (result.status === "failed") {
      setBack((current) => plannerSysOnce(current, strings.review.noReply));
    }
    return null;
  };

  const answer = async (raw: string) => {
    if (busyRef.current) return;
    const { back: next, reply: after } = plannerAddAnswer(
      stateRef.current.back,
      review,
      raw,
    );
    if (after === "none") return;
    setBack(() => next);
    if (after === "advance") {
      advance();
      return;
    }
    if (!coachOnRef.current) {
      if (after === "coach") advance();
      return;
    }
    if (after === "chat") {
      await coach("chat");
      return;
    }
    const { stage, pi } = next;
    const mode = plannerCoachMode(next);
    const reply = await coach(mode);
    const now = stateRef.current.back;
    if (!alive.current || now.stage !== stage || now.pi !== pi) return;
    if (!reply || mode === "force" || reply.advance) advance();
    else setBack(plannerAddProbe);
  };

  // --- The summary memo --------------------------------------------------------

  const [sheetOpen, setSheetOpen] = useState(false);
  const [memoLive, setMemoLive] = useState<string | null>(null);
  const [memoSaving, setMemoSaving] = useState(false);
  const [memoSaveFailed, setMemoSaveFailed] = useState(false);

  const saveLookBack = async (memo: string) => {
    const input = plannerLookBackInput(
      stateRef.current.back,
      review,
      today,
      memo,
    );
    if (!input) return;
    setMemoSaving(true);
    setMemoSaveFailed(false);
    try {
      await plannerLookBackRequest(week, input);
      if (!alive.current) return;
      update((current) => ({
        ...current,
        back: { ...current.back, memoSaved: true },
        forward: plannerPlanFromMemo(
          current.forward,
          memo,
          Boolean(review.look_forward_done_at),
          week,
        ),
      }));
      toast.success(strings.review.memo.savedToast);
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.reviewStatus(today),
      });
      void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.goals });
    } catch (failure) {
      if (!alive.current) return;
      setMemoSaveFailed(true);
      toast.error(
        plannerErrorMessage(
          failure,
          strings.review.memo.saveFailed,
          cockpit.toast.rateLimited,
        ),
      );
    } finally {
      if (alive.current) setMemoSaving(false);
    }
  };

  const writeMemo = async (again = false) => {
    const current = stateRef.current.back;
    if (current.stage !== "done" || memoAbort.current) return;
    if (!again && current.memo) {
      setSheetOpen(true);
      return;
    }
    setSheetOpen(true);
    setMemoLive("");
    const template = () =>
      plannerComposeSummaryMemo(plannerSummaryInput(current, review, today));
    let memo: string;
    let by: "model" | "page" = "page";
    let stopped = false;
    let note: string | null = null;
    if (review.ai) {
      const controller = new AbortController();
      memoAbort.current = controller;
      const scores = current.scores ?? {
        auth: drafts.scores.auth,
        ach: drafts.scores.ach,
      };
      const result = await plannerStreamMemo(
        week,
        {
          today,
          ...plannerAnswersInput(current, review),
          scores,
          question: current.question?.trim()
            ? current.question.trim().slice(0, 500)
            : null,
          verdict: current.verdict?.text.trim()
            ? {
                kind: current.verdict.kind,
                text: current.verdict.text.trim().slice(0, 1000),
              }
            : null,
          recommended:
            plannerDraftsOf(current, review).trajectory.recommended ??
            "continue",
          drafts: plannerMemoDrafts(plannerDraftsOf(current, review)),
        },
        {
          signal: controller.signal,
          onText: (text) => {
            if (alive.current) setMemoLive(text);
          },
        },
      );
      memoAbort.current = null;
      const text = result.text.trim();
      if (result.status === "done" && text) {
        memo = text;
        by = "model";
      } else if (result.status === "aborted" && text) {
        memo = text;
        by = "model";
        stopped = true;
        note = strings.review.memo.stoppedToast;
      } else {
        memo = template();
        note =
          result.status === "aborted"
            ? strings.review.memo.stoppedTemplateToast
            : strings.review.memo.templateToast;
      }
    } else {
      memo = template();
    }
    if (!alive.current) return;
    setMemoLive(null);
    setBack((latest) => ({
      ...latest,
      memo,
      memoBy: by,
      memoStopped: stopped,
    }));
    if (note) toast(note);
    await saveLookBack(memo);
  };

  const toLookForward = () => {
    setSheetOpen(false);
    void navigate({
      search: { part: "forward", step: stateRef.current.forward.step },
    });
  };

  const backActions = {
    start: () => {
      if (stateRef.current.back.stage !== "start") return;
      setBack((current) => ({ ...current, stage: "drafting" }));
      void runOpening();
    },
    answer: (text: string) => void answer(text),
    next: () => {
      if (busyRef.current) return;
      const stage = stateRef.current.back.stage;
      if (stage === "lastq" || stage === "p" || stage === "goals") advance();
    },
    goalResult: (goalId: string, result: PlannerGoalResult) =>
      setBack((current) => ({
        ...current,
        goalResults: { ...current.goalResults, [goalId]: result },
      })),
    stepScore: (kind: "auth" | "ach", delta: number) =>
      setBack((current) =>
        current.stage === "scores" && current.scores
          ? {
              ...current,
              scores: {
                ...current.scores,
                [kind]: plannerStepScore(current.scores[kind], delta),
              },
            }
          : current,
      ),
    keepScores: () => {
      if (stateRef.current.back.stage === "scores") advance();
    },
    writeMemo: () => void writeMemo(),
    openMemo: () => setSheetOpen(true),
    lookForward: toLookForward,
  };

  // --- Look forward ------------------------------------------------------------

  const boardQuery = useQuery({
    queryKey: plannerQueryKeys.board(today, false),
    queryFn: () => plannerFetchBoard({ today }),
    staleTime: 15_000,
    enabled: part === "forward",
  });
  const board = boardQuery.data;

  // The cards that already serve the plan's goals join the plan once.
  useEffect(() => {
    if (board) setForward((current) => plannerPrefillTasks(current, board));
  }, [board, setForward]);

  // Opening Look forward, or another of its steps, is remembered.
  useEffect(() => {
    if (part !== "forward") return;
    setForward((current) =>
      current.seen && current.step === step
        ? current
        : { ...current, seen: true, step },
    );
  }, [part, step, setForward]);

  const question = plannerPlanQuestion(forward, back, review);
  const signature = plannerPlanSignature(forward);
  const [check, setCheck] = useState<PlannerCheck | null>(null);

  // The conflict check runs when Commit opens on a plan it has not checked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for the plan
  useEffect(() => {
    if (part !== "forward" || step !== 4) return;
    if (check?.sig === signature) return;
    const plan = stateRef.current.forward;
    if (!review.ai) {
      setCheck({ sig: signature, status: "off", flags: [] });
      return;
    }
    if (plannerNamedGoals(plan).length === 0) {
      setCheck({ sig: signature, status: "done", flags: [] });
      return;
    }
    setCheck({ sig: signature, status: "running", flags: [] });
    let cancelled = false;
    plannerAiCheckRequest(week, plannerCheckInput(plan, today))
      .then((result) => {
        if (cancelled) return;
        setCheck({
          sig: signature,
          status: "done",
          flags: plannerCheckFlags(result.flags, plan),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setCheck({
          sig: signature,
          status: plannerAiFailure(error) === "unavailable" ? "off" : "failed",
          flags: [],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [part, step, signature]);

  const [savingWeek, setSavingWeek] = useState(false);

  const saveWeek = async () => {
    if (savingWeek) return;
    setSavingWeek(true);
    const plan = stateRef.current.forward;
    const finalQuestion = plannerPlanQuestion(
      plan,
      stateRef.current.back,
      review,
    );
    const flags =
      check?.status === "done" && check.sig === plannerPlanSignature(plan)
        ? check.flags
        : [];
    try {
      const input = plannerCommitInput(plan, finalQuestion, flags, today);
      const saved = await plannerLookForwardRequest(week, input);
      setForward((current) =>
        plannerAfterCommit(current, input, saved.created, finalQuestion),
      );
      await flush();
      plannerMarkWeekFresh();
      void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.all });
      toast.success(
        strings.review.forward.savedToast(
          strings.week(plannerWeekNumber(review.plan_week)),
        ),
      );
      void navigate({ to: "/cockpit" });
    } catch (failure) {
      toast.error(
        plannerErrorMessage(
          failure,
          strings.review.forward.saveFailed,
          cockpit.toast.rateLimited,
        ),
      );
    } finally {
      if (alive.current) setSavingWeek(false);
    }
  };

  const findCard = (
    cardId: string,
  ): {
    card: PlannerBoardCard;
    column: "todo" | "backlog" | "doing";
  } | null => {
    if (!board) return null;
    for (const column of ["todo", "backlog", "doing"] as const) {
      const card = board.columns[column].find((item) => item.id === cardId);
      if (card) return { card, column };
    }
    return null;
  };

  const forwardActions = {
    goStep: (next: number) => {
      const target = Math.min(4, Math.max(1, next));
      setForward((current) => ({ ...current, seen: true, step: target }));
      void navigate({ search: { part: "forward", step: target } });
    },
    keep: (flagId: string) =>
      setForward((current) => ({
        ...current,
        settled: { ...current.settled, [flagId]: { state: "kept" } },
      })),
    rewrite: (flagId: string, title: string) =>
      setForward((current) => ({
        ...current,
        settled: {
          ...current.settled,
          [flagId]: { state: "rewritten", title },
        },
      })),
    undo: (flagId: string) =>
      setForward((current) => {
        const { [flagId]: _, ...settled } = current.settled;
        return { ...current, settled };
      }),
    setGoalTitle: (goalId: string, title: string) =>
      setForward((current) => ({
        ...current,
        edited: true,
        goals: current.goals.map((goal) => {
          if (goal.id !== goalId) return goal;
          const { fromSummary: _, ...typed } = goal;
          return { ...typed, title };
        }),
      })),
    setGoalPillar: (goalId: string, pillar: PlannerPillar) =>
      setForward((current) => ({
        ...current,
        edited: true,
        goals: current.goals.map((goal) =>
          goal.id === goalId ? { ...goal, pillar } : goal,
        ),
      })),
    removeGoal: (goalId: string) =>
      setForward((current) => ({
        ...current,
        edited: true,
        goals: current.goals.filter((goal) => goal.id !== goalId),
        tasks: current.tasks.filter((task) => task.goal_id !== goalId),
      })),
    addGoal: () =>
      setForward((current) => {
        if (current.goals.length >= 12) return current;
        const pillar =
          plannerPillars.find(
            (item) => !current.goals.some((goal) => goal.pillar === item),
          ) ?? "of";
        return {
          ...current,
          edited: true,
          goals: [
            ...current.goals,
            { id: plannerNewId(), pillar, title: "", custom: true },
          ],
        };
      }),
    toggleBacklog: (cardId: string) =>
      setForward((current) => ({
        ...current,
        edited: true,
        toBacklog: current.toBacklog.includes(cardId)
          ? current.toBacklog.filter((id) => id !== cardId)
          : [...current.toBacklog, cardId],
      })),
    addNewTask: (goalId: string, title: string) =>
      setForward((current) =>
        board && plannerTodoCount(current, board) >= plannerTodoCap
          ? current
          : plannerAddNewTask(current, goalId, title),
      ),
    addBoardTask: (goalId: string, cardId: string) => {
      const found = findCard(cardId);
      if (!found) return;
      setForward((current) =>
        plannerAddBoardTask(current, goalId, found.card, found.column),
      );
    },
    removeTask: (ref: string) =>
      setForward((current) => ({
        ...current,
        edited: true,
        tasks: current.tasks.filter((task) => task.ref !== ref),
      })),
    setQuestion: (text: string) =>
      setForward((current) => ({ ...current, question: text })),
    save: () => void saveWeek(),
  };

  return (
    <>
      <Parts
        back={back}
        forward={forward}
        lookBackDone={lookBackDone}
        part={part}
        review={review}
        step={step}
        strings={strings}
      />
      <div className={cn(part === "forward" && "pt-1")}>
        {part === "back" ? (
          <PlannerLookBack
            actions={backActions}
            back={back}
            busy={busy}
            coach={coachOn}
            done={lookBackDone}
            drafts={drafts}
            live={live}
            review={review}
            strings={strings}
            writing={memoLive !== null}
          />
        ) : (
          <PlannerLookForward
            actions={forwardActions}
            board={board}
            check={check}
            forward={forward}
            question={question}
            review={review}
            saved={Boolean(review.look_forward_done_at)}
            saving={savingWeek}
            step={step}
            strings={strings}
          />
        )}
      </div>
      <PlannerMemoSheet
        canWriteAgain={
          review.ai &&
          back.stage === "done" &&
          (back.memoStopped || back.memoBy === "page")
        }
        live={memoLive}
        memo={back.memo ?? review.summary?.content ?? null}
        memoBy={back.memoBy}
        open={sheetOpen}
        saveFailed={memoSaveFailed}
        saving={memoSaving}
        stopped={back.memoStopped}
        strings={strings}
        week={week}
        onClose={() => {
          memoAbort.current?.abort();
          setSheetOpen(false);
        }}
        onLookForward={toLookForward}
        onRetrySave={() => {
          const memo = stateRef.current.back.memo;
          if (memo) void saveLookBack(memo);
        }}
        onStop={() => memoAbort.current?.abort()}
        onWriteAgain={() => void writeMemo(true)}
      />
    </>
  );
}
