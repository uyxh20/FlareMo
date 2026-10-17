import {
  type PlannerForecastGrade,
  type PlannerGoalDecision,
  type PlannerGoalResult,
  type PlannerPeriodGoal,
  type PlannerPeriodLevel,
  type PlannerPeriodReviewResponse,
  type PlannerPillar,
  type PlannerVerdictKind,
  type PlannerWeekMark,
  plannerFormatScore,
  plannerNextPeriodStartOf,
  plannerPeriodLevels,
  plannerPeriodSteps,
  plannerPillars,
  plannerPreviousPeriodStartOf,
  plannerScoreFloors,
} from "@flaremo/contracts";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CalendarRangeIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { QueryErrorState } from "@/components/query-error-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { WorkspacePageHeader } from "@/components/workspace/workspace-page-header";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { plannerErrorMessage } from "./api";
import { plannerAiFailure } from "./goals-api";
import { usePlannerGoalsStrings } from "./goals-strings";
import { PlannerBadge, PlannerChoice, PlannerSectionTitle } from "./goals-ui";
import {
  plannerFetchPeriodReview,
  plannerPeriodChecksRequest,
  plannerPeriodThemesRequest,
  plannerSavePeriodRequest,
  plannerSavePeriodStateRequest,
  plannerStartPeriodOverRequest,
  plannerStreamPeriodCoach,
  plannerStreamPeriodMemo,
} from "./period-api";
import { PlannerPeriodChat } from "./period-chat";
import {
  type PlannerPeriodState,
  plannerGradeAboveReceipts,
  plannerPeriodScoreStats,
  plannerPeriodTemplate,
  plannerRestorePeriodState,
} from "./period-model";
import {
  type PlannerPeriodStrings,
  usePlannerPeriodStrings,
} from "./period-strings";
import { plannerQueryKeys } from "./query-keys";
import { PlannerMarkdown } from "./review-markdown";
import { usePlannerToday } from "./use-planner-clock";

// The month, quarter and year reviews (fork-owned add-on,
// docs/planning-cockpit-period-review.md): the "superset" that runs after the
// weekly review's Look back on the Sunday a period closes, before its Look
// forward. The month and quarter run as the weekly review's chat over the
// period (period-chat.tsx); the year keeps the five steps below. Every step has the same
// shape as the weekly review: the raw rows on the right, the owner's own words
// and a chat with the reader on the left, then a memo the owner edits and
// saves. The page owns the state and the model calls; the pure parts are in
// period-model.ts.

const SAVE_DELAY = 800;

export function PlannerPeriodPage() {
  const { t } = useI18n();
  const strings = usePlannerPeriodStrings();
  const today = usePlannerToday();
  const search = useSearch({ from: "/period-review" });
  const navigate = useNavigate({ from: "/period-review" });
  const queryClient = useQueryClient();
  const [run, setRun] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const query = useQuery({
    queryKey: plannerQueryKeys.periodReview(today, search.level, search.period),
    queryFn: () =>
      plannerFetchPeriodReview({
        today,
        level: search.level,
        period: search.period,
      }),
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const review = query.data;

  const restart = async () => {
    if (!review) return;
    setRestarting(true);
    try {
      await plannerStartPeriodOverRequest(review.level, review.period_start);
      await query.refetch();
      setRun((current) => current + 1);
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.periodStatus(today),
      });
      void navigate({ search: { ...search, step: 1 } });
    } catch (error) {
      toast.error(
        plannerErrorMessage(error, strings.startOverFailed, strings.limited),
      );
    } finally {
      setRestarting(false);
    }
  };

  let content: ReactNode;
  if (query.isError && !review) {
    content = (
      <QueryErrorState
        className="min-h-56"
        isRetrying={query.isRefetching}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (!review) {
    content = (
      <div
        className="flex flex-col gap-3 py-2"
        data-testid="planner-period-loading"
      >
        <Skeleton className="h-12" />
        <Skeleton className="h-[420px]" />
      </div>
    );
  } else {
    // The year review keeps its own steps for now (parked, 17 October 2026).
    content =
      review.level === "year" ? (
        <PeriodSession
          key={`${review.level}:${review.period_start}:${run}`}
          review={review}
          step={search.step}
          strings={strings}
          today={today}
        />
      ) : (
        <PeriodChatSession
          key={`${review.level}:${review.period_start}:${run}`}
          review={review}
          strings={strings}
          today={today}
        />
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
            <CalendarRangeIcon className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />
          }
          maxWidthClass="max-w-[1320px]"
          mobileSheetOpen={mobileSheetOpen}
          setMobileSheetOpen={setMobileSheetOpen}
          sidebarCollapsed={sidebarCollapsed}
          title={strings.title}
          toggleSidebarCollapsed={toggleSidebarCollapsed}
          actions={
            review && (
              <Button
                data-testid="planner-period-start-over"
                disabled={restarting}
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(true)}
              >
                {strings.startOver}
              </Button>
            )
          }
        />
      )}
    >
      <div className="flex flex-col gap-3 pb-10" data-testid="planner-period">
        {content}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{strings.startOverTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {strings.startOverBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void restart()}
            >
              {strings.startOver}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkspaceLayout>
  );
}

// ---------------------------------------------------------------------------
// The header: level, period, and where the review stands
// ---------------------------------------------------------------------------

function PeriodNav({
  review,
  savedAt,
  strings,
  today,
}: {
  review: PlannerPeriodReviewResponse;
  savedAt: string | null;
  strings: PlannerPeriodStrings;
  today: string;
}) {
  const { level, period_start: period } = review;
  const due = review.due.find(
    (entry) => entry.level === level && entry.period_start === period,
  );
  const previousPeriod = plannerPreviousPeriodStartOf(level, period);
  const nextPeriod = plannerNextPeriodStartOf(level, period);
  return (
    <>
      <nav
        aria-label={strings.title}
        className="flex flex-wrap items-center gap-2"
      >
        <div
          className="flex gap-1 rounded-xl border border-border bg-card p-1"
          role="tablist"
        >
          {plannerPeriodLevels.map((item) => (
            <Link
              aria-current={item === level ? "page" : undefined}
              className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground aria-[current=page]:bg-brand-500 aria-[current=page]:text-white aria-[current=page]:font-medium hover:text-foreground"
              data-testid={`planner-period-level-${item}`}
              key={item}
              search={{ level: item, period: undefined, step: undefined }}
              to="/period-review"
            >
              {strings.levels[item]}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Link
            aria-label={strings.previous}
            className="rounded-lg border border-border px-2 py-1 text-sm hover:bg-muted"
            search={{ level, period: previousPeriod, step: undefined }}
            to="/period-review"
          >
            ←
          </Link>
          <span
            className="px-1 text-base font-semibold"
            data-testid="planner-period-label"
          >
            {review.label}
          </span>
          {nextPeriod <= today ? (
            <Link
              aria-label={strings.next}
              className="rounded-lg border border-border px-2 py-1 text-sm hover:bg-muted"
              search={{ level, period: nextPeriod, step: undefined }}
              to="/period-review"
            >
              →
            </Link>
          ) : (
            <span className="rounded-lg border border-border px-2 py-1 text-sm opacity-40">
              →
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {review.period_start} – {review.period_end} ·{" "}
          {strings.weeks(review.weeks.length)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs">
          {due ? (
            <PlannerBadge tone={due.done ? "met" : "brand"}>
              {due.done ? strings.done : strings.dueNow}
            </PlannerBadge>
          ) : (
            <span className="text-muted-foreground">{strings.notClosing}</span>
          )}
          {savedAt && (
            <span className="text-success">
              ✓ {strings.savedOn(savedAt.slice(0, 10))}
            </span>
          )}
        </span>
      </nav>

      {due && !review.look_back_done && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
          <span>{strings.lookBackFirst}</span>
          <Link
            className="font-medium underline"
            search={{ part: "back" }}
            to="/weekly-review"
          >
            {strings.openWeekly}
          </Link>
        </div>
      )}
    </>
  );
}

/** The month and quarter reviews: the weekly review's chat over the period. */
function PeriodChatSession({
  review,
  strings,
  today,
}: {
  review: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
  today: string;
}) {
  const [savedAt, setSavedAt] = useState<string | null>(review.done_at);
  return (
    <>
      <PeriodNav
        review={review}
        savedAt={savedAt}
        strings={strings}
        today={today}
      />
      <PlannerPeriodChat
        period={review}
        strings={strings}
        today={today}
        onSaved={setSavedAt}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// The session: state, autosave, model calls
// ---------------------------------------------------------------------------

function PeriodSession({
  review,
  step: searchStep,
  strings,
  today,
}: {
  review: PlannerPeriodReviewResponse;
  step: number | undefined;
  strings: PlannerPeriodStrings;
  today: string;
}) {
  const goalsStrings = usePlannerGoalsStrings();
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: "/period-review" });
  const { level, period_start: period } = review;
  const steps = plannerPeriodSteps[level];

  const [state, setState] = useState<PlannerPeriodState>(() =>
    plannerRestorePeriodState(review.state, review),
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
      queryClient.setQueriesData<PlannerPeriodReviewResponse>(
        { queryKey: ["planner", "period-review", today] },
        (cached) =>
          cached?.level === level && cached.period_start === period
            ? { ...cached, state: saving }
            : cached,
      );
      try {
        await plannerSavePeriodStateRequest(level, period, saving, {
          keepalive,
        });
      } catch {
        dirty.current = true;
      }
    },
    [level, period, queryClient, today],
  );

  const update = useCallback(
    (change: (current: PlannerPeriodState) => PlannerPeriodState) => {
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

  useEffect(() => {
    alive.current = true;
    const hide = () => {
      if (document.visibilityState === "hidden") void flush(true);
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", hide);
      void flush(true);
    };
  }, [flush]);

  const step = Math.min(steps.length, Math.max(1, searchStep ?? state.step));
  const current = steps[step - 1] ?? steps[0];
  const goStep = (next: number) => {
    const target = Math.min(steps.length, Math.max(1, next));
    update((s) => ({ ...s, step: target }));
    void navigate({ search: { level, period, step: target } });
  };

  // --- The reader -----------------------------------------------------------

  const [live, setLive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [aiOff, setAiOff] = useState(!review.ai);

  const ask = async (stepId: string, text: string) => {
    if (busy) return;
    const trimmed = text.trim();
    const messages = [
      ...(stateRef.current.chat[stepId] ?? []),
      ...(trimmed ? [{ role: "user" as const, content: trimmed }] : []),
    ];
    if (trimmed) {
      update((s) => ({ ...s, chat: { ...s.chat, [stepId]: messages } }));
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setLive("");
    const result = await plannerStreamPeriodCoach(
      level,
      period,
      {
        today,
        step: stepId,
        messages: messages.slice(-30),
        answers: stateRef.current.answers,
      },
      {
        signal: abort.signal,
        onText: (piece) => alive.current && setLive(piece),
      },
    );
    if (!alive.current) return;
    setBusy(false);
    setLive(null);
    if (result.text.trim()) {
      const reply = { role: "assistant" as const, content: result.text.trim() };
      update((s) => ({
        ...s,
        chat: { ...s.chat, [stepId]: [...(s.chat[stepId] ?? []), reply] },
      }));
    }
    if (result.status === "unavailable") {
      setAiOff(true);
      toast(strings.modelUnavailable);
    } else if (result.status === "limited") toast(strings.limited);
    else if (result.status === "failed") toast(strings.modelFailed);
  };

  const [checking, setChecking] = useState(false);
  const runChecks = async () => {
    setChecking(true);
    try {
      const checks = await plannerPeriodChecksRequest(level, period, today);
      update((s) => ({ ...s, checks }));
    } catch (error) {
      const why = plannerAiFailure(error);
      if (why === "unavailable") setAiOff(true);
      toast(
        why === "unavailable"
          ? strings.modelUnavailable
          : why === "limited"
            ? strings.limited
            : strings.modelFailed,
      );
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const [readingTwice, setReadingTwice] = useState(false);
  const readTwice = async () => {
    setReadingTwice(true);
    try {
      const themes = await plannerPeriodThemesRequest(level, period, today);
      update((s) => ({ ...s, themes }));
    } catch (error) {
      const why = plannerAiFailure(error);
      if (why === "unavailable") setAiOff(true);
      toast(
        why === "unavailable"
          ? strings.modelUnavailable
          : why === "limited"
            ? strings.limited
            : strings.modelFailed,
      );
    } finally {
      if (alive.current) setReadingTwice(false);
    }
  };

  // --- The memo ---------------------------------------------------------------

  const [memoLive, setMemoLive] = useState<string | null>(null);
  const memoAbort = useRef<AbortController | null>(null);
  const writeMemo = async () => {
    const s = stateRef.current;
    const template = () => plannerPeriodTemplate(review, s);
    if (aiOff) {
      update((c) => ({
        ...c,
        memo: template(),
        draftMemo: null,
        memoBy: "page",
        memoSaved: false,
      }));
      return;
    }
    const abort = new AbortController();
    memoAbort.current = abort;
    setMemoLive("");
    const result = await plannerStreamPeriodMemo(
      level,
      period,
      {
        today,
        answers: s.answers,
        goal_results: Object.entries(s.goals).map(([goal_id, entry]) => ({
          goal_id,
          result: entry.result,
          decision: entry.decision,
          note: entry.note || null,
        })),
        verdict: s.verdict,
        forecast: s.forecast.trim() || null,
      },
      {
        signal: abort.signal,
        onText: (text) => alive.current && setMemoLive(text),
      },
    );
    if (!alive.current) return;
    setMemoLive(null);
    const text = result.text.trim();
    if ((result.status === "done" || result.status === "aborted") && text) {
      update((c) => ({
        ...c,
        memo: text,
        draftMemo: text,
        memoBy: "model",
        memoSaved: false,
      }));
      return;
    }
    if (result.status === "unavailable") setAiOff(true);
    update((c) => ({
      ...c,
      memo: template(),
      draftMemo: null,
      memoBy: "page",
      memoSaved: false,
    }));
    toast(
      result.status === "unavailable"
        ? strings.modelUnavailable
        : result.status === "limited"
          ? strings.limited
          : strings.modelFailed,
    );
  };

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(review.done_at);
  const [rewriteRate, setRewriteRate] = useState<number | null>(
    review.rewrite_rate,
  );
  const [evidenceSaved, setEvidenceSaved] = useState(review.evidence);
  const save = async () => {
    const s = stateRef.current;
    const memo = s.memo?.trim();
    if (!memo) return;
    setSaving(true);
    try {
      const saved = await plannerSavePeriodRequest(level, period, {
        today,
        memo,
        draft_memo: s.draftMemo,
        verdict: s.verdict,
        forecast: s.forecast.trim() || null,
        previous_grade: s.previousGrade,
        goal_results: Object.entries(s.goals).map(([goal_id, entry]) => ({
          goal_id,
          result: entry.result,
          decision: entry.decision,
          note: entry.note || null,
        })),
        evidence: s.evidence,
        week_marks: s.weekMarks,
      });
      update((c) => ({ ...c, memoSaved: true }));
      await flush();
      setSavedAt(saved.done_at);
      setRewriteRate(saved.rewrite_rate);
      setEvidenceSaved(saved.evidence);
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.periodStatus(today),
      });
      void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.goals });
      toast.success(strings.savedToast);
    } catch (error) {
      toast.error(
        plannerErrorMessage(error, strings.saveFailed, strings.limited),
      );
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  // --- Rendering ----------------------------------------------------------------

  const setAnswer = (stepId: string, line: string) =>
    update((s) => ({
      ...s,
      answers: { ...s.answers, [stepId]: [...(s.answers[stepId] ?? []), line] },
    }));
  const removeAnswer = (stepId: string, index: number) =>
    update((s) => ({
      ...s,
      answers: {
        ...s.answers,
        [stepId]: (s.answers[stepId] ?? []).filter((_, i) => i !== index),
      },
    }));
  const addEvidence = (
    claim: string,
    quote: string,
    pillar: PlannerPillar | null,
  ) =>
    update((s) => ({
      ...s,
      evidence: [...s.evidence, { claim, quote, pillar }].slice(0, 200),
    }));
  const removeEvidence = (index: number) =>
    update((s) => ({
      ...s,
      evidence: s.evidence.filter((_, i) => i !== index),
    }));
  const setGoal = (
    goalId: string,
    patch: Partial<{
      result: PlannerGoalResult | null;
      decision: PlannerGoalDecision | null;
      note: string;
    }>,
  ) =>
    update((s) => ({
      ...s,
      goals: {
        ...s.goals,
        [goalId]: {
          ...(s.goals[goalId] ?? { result: null, decision: null, note: "" }),
          ...patch,
        },
      },
    }));

  return (
    <>
      <PeriodNav
        review={review}
        savedAt={savedAt}
        strings={strings}
        today={today}
      />

      <ol
        className="grid grid-cols-5 gap-1.5"
        data-testid="planner-period-steps"
      >
        {steps.map((item, index) => {
          const answered = (state.answers[item.id] ?? []).length > 0;
          return (
            <li key={item.id}>
              <button
                aria-current={index + 1 === step ? "step" : undefined}
                className="flex w-full flex-col gap-0.5 rounded-xl border border-border bg-card px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-[current=step]:border-brand-500 aria-[current=step]:bg-brand-500/[0.07]"
                data-testid={`planner-period-step-${index + 1}`}
                type="button"
                onClick={() => goStep(index + 1)}
              >
                <span className="font-mono text-[11px] text-muted-foreground">
                  {index + 1}
                  {answered ? " ✓" : ""}
                </span>
                <span className="truncate text-xs font-semibold sm:text-sm">
                  {item.title}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section
          className="flex min-w-0 flex-col gap-4"
          data-testid="planner-period-step"
        >
          <header>
            <p className="text-xs text-muted-foreground">
              {strings.stepOf(step, steps.length)} · {strings.from}:{" "}
              {current.from}
            </p>
            <h2 className="text-lg font-semibold leading-snug">
              {current.question}
            </h2>
          </header>

          {level === "month" && current.id === "check" && (
            <ChecksPanel
              aiOff={aiOff}
              checks={state.checks}
              checking={checking}
              strings={strings}
              onAddReceipt={addEvidence}
              onRun={() => void runChecks()}
            />
          )}
          {level === "month" && current.id === "questions" && (
            <QuestionsPanel review={review} strings={strings} />
          )}
          {current.id === "goals" && (
            <GoalsPanel
              level={level}
              receipts={state.evidence}
              review={review}
              state={state}
              strings={strings}
              onChange={setGoal}
            />
          )}
          {level === "quarter" && current.id === "themes" && (
            <ThemesPanel
              aiOff={aiOff}
              reading={readingTwice}
              strings={strings}
              themes={state.themes}
              onAddReceipt={addEvidence}
              onRun={() => void readTwice()}
            />
          )}
          {level === "quarter" && current.id === "scores" && (
            <ScoresPanel review={review} strings={strings} />
          )}
          {level === "year" && current.id === "calendar" && (
            <CalendarPanel
              marks={state.weekMarks}
              review={review}
              strings={strings}
              onMark={(monday, mark) =>
                update((s) => ({
                  ...s,
                  weekMarks:
                    s.weekMarks[monday] === mark
                      ? Object.fromEntries(
                          Object.entries(s.weekMarks).filter(
                            ([key]) => key !== monday,
                          ),
                        )
                      : { ...s.weekMarks, [monday]: mark },
                }))
              }
            />
          )}
          {level === "year" && current.id === "northstar" && (
            <NorthStarPanel review={review} strings={strings} />
          )}
          {level === "year" && current.id === "beliefs" && (
            <BeliefsPanel review={review} strings={strings} />
          )}
          {(current.id === "verdict" ||
            current.id === "close" ||
            current.id === "sentence") && (
            <VerdictPanel
              review={review}
              state={state}
              strings={strings}
              onForecast={(forecast) => update((s) => ({ ...s, forecast }))}
              onGrade={(previousGrade) =>
                update((s) => ({ ...s, previousGrade }))
              }
              onVerdict={(verdict) => update((s) => ({ ...s, verdict }))}
            />
          )}

          <Words
            lines={state.answers[current.id] ?? []}
            strings={strings}
            onAdd={(line) => setAnswer(current.id, line)}
            onRemove={(index) => removeAnswer(current.id, index)}
          />

          <Chat
            aiOff={aiOff}
            busy={busy}
            live={live}
            messages={state.chat[current.id] ?? []}
            strings={strings}
            onAsk={(text) => void ask(current.id, text)}
            onStop={() => abortRef.current?.abort()}
          />

          <div className="flex justify-between">
            <Button
              disabled={step <= 1}
              size="sm"
              variant="outline"
              onClick={() => goStep(step - 1)}
            >
              ← {strings.previous}
            </Button>
            {step < steps.length ? (
              <Button
                data-testid="planner-period-next"
                size="sm"
                onClick={() => goStep(step + 1)}
              >
                {strings.next} →
              </Button>
            ) : null}
          </div>

          {step === steps.length && (
            <MemoPanel
              live={memoLive}
              rewriteRate={rewriteRate}
              saving={saving}
              state={state}
              strings={strings}
              onEdit={(memo) =>
                update((s) => ({ ...s, memo, memoSaved: false }))
              }
              onSave={() => void save()}
              onStop={() => memoAbort.current?.abort()}
              onWrite={() => void writeMemo()}
            />
          )}
          {state.memoSaved && savedAt && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-success/40 bg-success/10 px-3 py-2 text-sm">
              <span>✓ {strings.saved}</span>
              <Link
                className="font-medium underline"
                search={{ part: "forward", step: 1 }}
                to="/weekly-review"
              >
                {strings.thenLookForward}
              </Link>
            </div>
          )}
        </section>

        <aside className="flex min-w-0 flex-col gap-4">
          <WeeksTable review={review} strings={strings} />
          <Receipts
            evidence={state.evidence}
            saved={evidenceSaved}
            strings={strings}
            onAdd={addEvidence}
            onRemove={removeEvidence}
          />
          {current.id !== "goals" && (
            <GoalsList
              goals={review.goals}
              strings={strings}
              title={strings.goalsTitle}
            />
          )}
          <PreviousForecast review={review} strings={strings} />
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {strings.rungs}.
            </span>{" "}
            {strings.rungsHint}
          </p>
          <p className="sr-only">{goalsStrings.noPillar}</p>
        </aside>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Panel({
  title,
  children,
  testId,
}: {
  title?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3"
      data-testid={testId}
    >
      {title && <PlannerSectionTitle>{title}</PlannerSectionTitle>}
      {children}
    </div>
  );
}

function Verified({
  verified,
  strings,
}: {
  verified: boolean;
  strings: PlannerPeriodStrings;
}) {
  return (
    <PlannerBadge tone={verified ? "met" : "neutral"}>
      {verified ? strings.verified : strings.unsourced}
    </PlannerBadge>
  );
}

function Words({
  lines,
  strings,
  onAdd,
  onRemove,
}: {
  lines: string[];
  strings: PlannerPeriodStrings;
  onAdd: (line: string) => void;
  onRemove: (index: number) => void;
}) {
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const line = text.trim();
    if (!line) return;
    onAdd(line);
    setText("");
  };
  return (
    <Panel testId="planner-period-words" title={strings.yourWords}>
      <p className="text-xs text-muted-foreground">{strings.yourWordsHint}</p>
      {lines.length > 0 && (
        <ul className="flex flex-col gap-1">
          {lines.map((line, index) => (
            <li
              className="flex items-start gap-2 text-sm"
              // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
              key={`${index}-${line.slice(0, 20)}`}
            >
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{line}</span>
              <button
                aria-label={strings.removeReceipt}
                className="text-xs text-muted-foreground hover:text-foreground"
                type="button"
                onClick={() => onRemove(index)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={submit}
      >
        <Textarea
          className="min-h-16 flex-1"
          data-testid="planner-period-words-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              submit(event);
          }}
        />
        <Button
          data-testid="planner-period-words-add"
          size="sm"
          type="submit"
          variant="outline"
        >
          {strings.add}
        </Button>
      </form>
    </Panel>
  );
}

function Chat({
  messages,
  live,
  busy,
  aiOff,
  strings,
  onAsk,
  onStop,
}: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  live: string | null;
  busy: boolean;
  aiOff: boolean;
  strings: PlannerPeriodStrings;
  onAsk: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when a message or a streamed piece arrives
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [count, live]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    onAsk(text);
    setText("");
  };
  return (
    <Panel testId="planner-period-chat" title={strings.askReader}>
      <p className="text-xs text-muted-foreground">
        {aiOff ? strings.readerOff : strings.askReaderHint}
      </p>
      {(messages.length > 0 || live !== null) && (
        <div className="flex max-h-[420px] flex-col gap-2.5 overflow-y-auto">
          {messages.map((message, index) => (
            <div
              className={cn(
                "max-w-[92%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap",
                message.role === "user"
                  ? "self-end bg-brand-500/10"
                  : "self-start border border-border bg-background",
              )}
              // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
              key={`${index}-${message.content.slice(0, 16)}`}
            >
              {message.content}
            </div>
          ))}
          {live !== null && (
            <div className="max-w-[92%] self-start rounded-xl border border-border bg-background px-3 py-2 text-sm whitespace-pre-wrap">
              {live || strings.readerBusy}
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
      {!aiOff && (
        <form className="flex gap-2" onSubmit={submit}>
          <Textarea
            className="min-h-10 flex-1"
            data-testid="planner-period-chat-input"
            disabled={busy}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) submit(event);
            }}
          />
          {busy ? (
            <Button size="sm" type="button" variant="outline" onClick={onStop}>
              {strings.stop}
            </Button>
          ) : (
            <Button
              data-testid="planner-period-chat-send"
              size="sm"
              type="submit"
            >
              {messages.length === 0 && !text.trim()
                ? strings.askReader
                : strings.send}
            </Button>
          )}
        </form>
      )}
    </Panel>
  );
}

function ChecksPanel({
  aiOff,
  checks,
  checking,
  strings,
  onRun,
  onAddReceipt,
}: {
  aiOff: boolean;
  checks: PlannerPeriodState["checks"];
  checking: boolean;
  strings: PlannerPeriodStrings;
  onRun: () => void;
  onAddReceipt: (
    claim: string,
    quote: string,
    pillar: PlannerPillar | null,
  ) => void;
}) {
  return (
    <Panel testId="planner-period-checks">
      <div>
        {aiOff ? (
          <p className="text-sm text-muted-foreground">{strings.readerOff}</p>
        ) : (
          <Button
            data-testid="planner-period-run-checks"
            disabled={checking}
            size="sm"
            onClick={onRun}
          >
            {checking ? strings.runningChecks : strings.runChecks}
          </Button>
        )}
      </div>
      {checks && checks.checks.length === 0 && checks.left_out.length === 0 && (
        <p className="text-sm text-muted-foreground">{strings.checksEmpty}</p>
      )}
      {checks && checks.checks.length > 0 && (
        <>
          <PlannerSectionTitle>{strings.claims}</PlannerSectionTitle>
          <ul className="flex flex-col gap-2">
            {checks.checks.map((check, index) => (
              <li
                className="flex flex-col gap-1 rounded-lg border border-border p-2 text-sm"
                // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
                key={`${index}-${check.claim.slice(0, 12)}`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {check.week_start}
                  </span>
                  <PlannerBadge tone={check.holds ? "met" : "missed"}>
                    {check.holds ? strings.holds : strings.unsupported}
                  </PlannerBadge>
                  <Verified strings={strings} verified={check.verified} />
                </div>
                <span>{check.claim}</span>
                {check.quote && (
                  <q className="text-muted-foreground">{check.quote}</q>
                )}
                {check.verified && (
                  <button
                    className="self-start text-xs underline"
                    type="button"
                    onClick={() => onAddReceipt(check.claim, check.quote, null)}
                  >
                    {strings.useAsReceipt}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {checks && checks.left_out.length > 0 && (
        <>
          <PlannerSectionTitle>{strings.leftOut}</PlannerSectionTitle>
          <ul className="flex flex-col gap-2">
            {checks.left_out.map((item, index) => (
              <li
                className="flex flex-col gap-1 rounded-lg border border-border p-2 text-sm"
                // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
                key={`${index}-${item.quote.slice(0, 12)}`}
              >
                <div className="flex items-center gap-1.5">
                  <Verified strings={strings} verified={item.verified} />
                </div>
                <q>{item.quote}</q>
                <span className="text-muted-foreground">{item.why}</span>
                {item.verified && (
                  <button
                    className="self-start text-xs underline"
                    type="button"
                    onClick={() =>
                      onAddReceipt(item.why || item.quote, item.quote, null)
                    }
                  >
                    {strings.useAsReceipt}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function QuestionsPanel({
  review,
  strings,
}: {
  review: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
}) {
  return (
    <Panel testId="planner-period-questions" title={strings.questions}>
      <ul className="flex flex-col gap-1.5 text-sm">
        {review.weeks.map((week) => (
          <li className="flex gap-2" key={week.week_start}>
            <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
              W{week.number}
            </span>
            <span
              className={cn(!week.question && "text-muted-foreground italic")}
            >
              {week.question ?? strings.noQuestion}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function GoalRow({
  goal,
  entry,
  level,
  receipts,
  strings,
  onChange,
}: {
  goal: PlannerPeriodGoal;
  entry: PlannerPeriodState["goals"][string] | undefined;
  level: PlannerPeriodLevel;
  receipts: number;
  strings: PlannerPeriodStrings;
  onChange: (
    patch: Partial<{
      result: PlannerGoalResult | null;
      decision: PlannerGoalDecision | null;
      note: string;
    }>,
  ) => void;
}) {
  const above = plannerGradeAboveReceipts(goal, entry, receipts);
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-2.5"
      data-testid="planner-period-goal"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {goal.pillar && <PlannerBadge tone="brand">{goal.pillar}</PlannerBadge>}
        <span className="text-sm font-medium">
          {goal.title || "(untitled)"}
        </span>
        {goal.tasks_linked > 0 && (
          <span className="text-xs text-muted-foreground">
            {strings.tasksLinked(goal.tasks_done, goal.tasks_linked)}
          </span>
        )}
        {above && (
          <PlannerBadge tone="missed">{strings.gradeAbove}</PlannerBadge>
        )}
      </div>
      {goal.lines.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {goal.lines.map((line, index) => (
            <li
              className={cn(line.struck && "line-through")}
              // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
              key={`${index}-${line.text.slice(0, 12)}`}
            >
              {line.text}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-3">
        <PlannerChoice
          label={strings.result.met}
          options={(["met", "partial", "missed"] as const).map((value) => ({
            value,
            label: strings.result[value],
          }))}
          value={entry?.result ?? null}
          onChange={(result) => onChange({ result })}
        />
        {level === "quarter" && (
          <PlannerChoice
            label={strings.decision.keep}
            options={(["keep", "rephrase", "kill"] as const).map((value) => ({
              value,
              label: strings.decision[value],
            }))}
            value={entry?.decision ?? null}
            onChange={(decision) => onChange({ decision })}
          />
        )}
      </div>
      <input
        className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
        placeholder={strings.note}
        value={entry?.note ?? ""}
        onChange={(event) => onChange({ note: event.target.value })}
      />
    </li>
  );
}

function GoalsPanel({
  review,
  state,
  level,
  receipts,
  strings,
  onChange,
}: {
  review: PlannerPeriodReviewResponse;
  state: PlannerPeriodState;
  level: PlannerPeriodLevel;
  receipts: PlannerPeriodState["evidence"];
  strings: PlannerPeriodStrings;
  onChange: (
    goalId: string,
    patch: Partial<{
      result: PlannerGoalResult | null;
      decision: PlannerGoalDecision | null;
      note: string;
    }>,
  ) => void;
}) {
  const receiptsFor = (goal: PlannerPeriodGoal) =>
    receipts.filter(
      (r) =>
        r.pillar === goal.pillar ||
        r.claim.toLowerCase().includes(goal.title.toLowerCase().slice(0, 24)),
    ).length;
  const list = (goals: PlannerPeriodGoal[]) =>
    goals.length === 0 ? (
      <p className="text-sm text-muted-foreground">{strings.noGoals}</p>
    ) : (
      <ul className="flex flex-col gap-2">
        {goals.map((goal) => (
          <GoalRow
            entry={state.goals[goal.id]}
            goal={goal}
            key={goal.id}
            level={level}
            receipts={receiptsFor(goal)}
            strings={strings}
            onChange={(patch) => onChange(goal.id, patch)}
          />
        ))}
      </ul>
    );
  return (
    <>
      <Panel testId="planner-period-goals" title={strings.goalsTitle}>
        {list(review.goals)}
      </Panel>
      {level !== "month" && review.child_goals.length > 0 && (
        <Panel title={strings.childGoals[level]}>
          {list(review.child_goals)}
        </Panel>
      )}
    </>
  );
}

function GoalsList({
  goals,
  strings,
  title,
}: {
  goals: PlannerPeriodGoal[];
  strings: PlannerPeriodStrings;
  title: string;
}) {
  return (
    <Panel title={title}>
      {goals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{strings.noGoals}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {goals.map((goal) => (
            <li className="flex flex-wrap items-center gap-1.5" key={goal.id}>
              {goal.pillar && (
                <PlannerBadge tone="brand">{goal.pillar}</PlannerBadge>
              )}
              <span>{goal.title || "(untitled)"}</span>
              {goal.result && (
                <PlannerBadge tone={goal.result}>
                  {strings.result[goal.result]}
                </PlannerBadge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ThemesPanel({
  aiOff,
  themes,
  reading,
  strings,
  onRun,
  onAddReceipt,
}: {
  aiOff: boolean;
  themes: PlannerPeriodState["themes"];
  reading: boolean;
  strings: PlannerPeriodStrings;
  onRun: () => void;
  onAddReceipt: (
    claim: string,
    quote: string,
    pillar: PlannerPillar | null,
  ) => void;
}) {
  return (
    <Panel testId="planner-period-themes">
      <div className="flex flex-wrap items-center gap-2">
        {aiOff ? (
          <p className="text-sm text-muted-foreground">{strings.readerOff}</p>
        ) : (
          <Button
            data-testid="planner-period-read-twice"
            disabled={reading}
            size="sm"
            onClick={onRun}
          >
            {reading ? strings.readingTwice : strings.readTwice}
          </Button>
        )}
        {themes && (
          <PlannerBadge tone="brand">
            {strings.agreement(Math.round(themes.agreement * 100))}
          </PlannerBadge>
        )}
      </div>
      {themes && (
        <ul className="flex flex-col gap-2">
          {themes.themes.map((theme, index) => (
            <li
              className="flex flex-col gap-1 rounded-lg border border-border p-2 text-sm"
              // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
              key={`${index}-${theme.label}`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{theme.label}</span>
                {theme.pillar && (
                  <PlannerBadge tone="brand">{theme.pillar}</PlannerBadge>
                )}
                <PlannerBadge tone={theme.readers === 2 ? "met" : "neutral"}>
                  {theme.readers === 2
                    ? strings.bothReaders
                    : strings.oneReader}
                </PlannerBadge>
                <Verified strings={strings} verified={theme.verified} />
              </div>
              {theme.quote && (
                <q className="text-muted-foreground">{theme.quote}</q>
              )}
              {theme.verified && (
                <button
                  className="self-start text-xs underline"
                  type="button"
                  onClick={() =>
                    onAddReceipt(theme.label, theme.quote, theme.pillar)
                  }
                >
                  {strings.useAsReceipt}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ScoresPanel({
  review,
  strings,
}: {
  review: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
}) {
  const stats = plannerPeriodScoreStats(review.weeks);
  const cell = (value: number | null, floor: number) =>
    value === null ? (
      <span className="text-muted-foreground">–</span>
    ) : (
      <span className={cn(value < floor && "text-destructive font-medium")}>
        {plannerFormatScore(value)}
      </span>
    );
  const line = (
    label: string,
    stat: { mean: number | null; spread: number | null; below: number },
  ) => (
    <p className="text-sm">
      <span className="font-medium">{label}</span>: {strings.mean}{" "}
      {stat.mean ?? "–"} · {strings.spread} {stat.spread ?? "–"} ·{" "}
      {strings.belowFloor(stat.below)}
    </p>
  );
  return (
    <Panel testId="planner-period-scores" title={strings.scoresTitle}>
      <div className="grid grid-cols-[auto_repeat(2,minmax(0,1fr))] gap-x-3 gap-y-0.5 text-sm tabular-nums">
        <span className="text-xs text-muted-foreground">{strings.week}</span>
        <span className="text-xs text-muted-foreground">
          {strings.authenticity}
        </span>
        <span className="text-xs text-muted-foreground">
          {strings.achievement}
        </span>
        {review.weeks.map((week) => (
          <ScoresRow cell={cell} key={week.week_start} week={week} />
        ))}
      </div>
      {line(strings.authenticity, stats.auth)}
      {line(strings.achievement, stats.ach)}
    </Panel>
  );
}

function ScoresRow({
  week,
  cell,
}: {
  week: PlannerPeriodReviewResponse["weeks"][number];
  cell: (value: number | null, floor: number) => ReactNode;
}) {
  return (
    <>
      <span className="font-mono text-xs text-muted-foreground">
        W{week.number}
      </span>
      {cell(week.auth, plannerScoreFloors.auth)}
      {cell(week.ach, plannerScoreFloors.ach)}
    </>
  );
}

function CalendarPanel({
  review,
  marks,
  strings,
  onMark,
}: {
  review: PlannerPeriodReviewResponse;
  marks: Record<string, PlannerWeekMark>;
  strings: PlannerPeriodStrings;
  onMark: (monday: string, mark: PlannerWeekMark) => void;
}) {
  return (
    <Panel testId="planner-period-calendar" title={strings.calendar}>
      <ul className="flex flex-col gap-1">
        {review.weeks.map((week) => (
          <li
            className={cn(
              "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-lg px-1.5 py-1 text-sm",
              marks[week.week_start] === "repeat" && "bg-success/10",
              marks[week.week_start] === "never" && "bg-destructive/10",
            )}
            key={week.week_start}
          >
            <span className="w-10 font-mono text-xs text-muted-foreground">
              W{week.number}
            </span>
            <span className="min-w-0 truncate text-muted-foreground">
              {week.first_lines[0] ?? strings.noEntries}
            </span>
            <span className="flex gap-1">
              <button
                aria-pressed={marks[week.week_start] === "repeat"}
                className="rounded-full border border-border px-2 text-xs aria-pressed:border-success aria-pressed:text-success"
                type="button"
                onClick={() => onMark(week.week_start, "repeat")}
              >
                + {strings.mark.repeat}
              </button>
              <button
                aria-pressed={marks[week.week_start] === "never"}
                className="rounded-full border border-border px-2 text-xs aria-pressed:border-destructive aria-pressed:text-destructive"
                type="button"
                onClick={() => onMark(week.week_start, "never")}
              >
                − {strings.mark.never}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function NorthStarPanel({
  review,
  strings,
}: {
  review: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
}) {
  return (
    <Panel title="North star">
      <p className="text-sm">{review.north_star?.title ?? strings.noGoals}</p>
      {review.north_star && review.north_star.lines.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {review.north_star.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
            <li key={`${index}-${line.text.slice(0, 12)}`}>{line.text}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function BeliefsPanel({
  review,
  strings,
}: {
  review: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
}) {
  return (
    <Panel testId="planner-period-beliefs" title={strings.beliefs}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <PlannerBadge tone="brand">
            {strings.created(review.memories.created)}
          </PlannerBadge>
          <ul className="mt-1.5 flex flex-col gap-1 text-sm text-muted-foreground">
            {review.memories.created_lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
              <li key={`${index}-${line.slice(0, 12)}`}>{line}</li>
            ))}
          </ul>
        </div>
        <div>
          <PlannerBadge tone="partial">
            {strings.revised(review.memories.revised)}
          </PlannerBadge>
          <ul className="mt-1.5 flex flex-col gap-1 text-sm text-muted-foreground">
            {review.memories.revised_lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
              <li key={`${index}-${line.slice(0, 12)}`}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

function VerdictPanel({
  review,
  state,
  strings,
  onVerdict,
  onForecast,
  onGrade,
}: {
  review: PlannerPeriodReviewResponse;
  state: PlannerPeriodState;
  strings: PlannerPeriodStrings;
  onVerdict: (
    verdict: { kind: PlannerVerdictKind; text: string } | null,
  ) => void;
  onForecast: (forecast: string) => void;
  onGrade: (grade: PlannerForecastGrade | null) => void;
}) {
  return (
    <Panel testId="planner-period-verdict">
      <PlannerSectionTitle>{strings.verdictTitle}</PlannerSectionTitle>
      <PlannerChoice
        label={strings.verdictTitle}
        options={(["continue", "pivot", "pause"] as const).map((value) => ({
          value,
          label: strings.verdictKinds[value],
        }))}
        value={state.verdict?.kind ?? null}
        onChange={(kind) =>
          onVerdict({ kind, text: state.verdict?.text ?? "" })
        }
      />
      <input
        className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
        data-testid="planner-period-verdict-text"
        placeholder={strings.verdictText}
        value={state.verdict?.text ?? ""}
        onChange={(event) =>
          onVerdict({
            kind: state.verdict?.kind ?? "continue",
            text: event.target.value,
          })
        }
      />
      <PlannerSectionTitle>{strings.forecastTitle}</PlannerSectionTitle>
      <p className="text-xs text-muted-foreground">{strings.forecastHint}</p>
      <Textarea
        className="min-h-14"
        data-testid="planner-period-forecast"
        value={state.forecast}
        onChange={(event) => onForecast(event.target.value)}
      />
      <PlannerSectionTitle>{strings.previousForecast}</PlannerSectionTitle>
      {review.previous?.forecast ? (
        <>
          <q className="text-sm">{review.previous.forecast}</q>
          <PlannerChoice
            label={strings.previousForecast}
            options={(["held", "partly", "missed"] as const).map((value) => ({
              value,
              label: strings.grade[value],
            }))}
            value={state.previousGrade}
            onChange={onGrade}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {strings.noPreviousForecast}
        </p>
      )}
    </Panel>
  );
}

function MemoPanel({
  state,
  live,
  saving,
  rewriteRate,
  strings,
  onWrite,
  onStop,
  onEdit,
  onSave,
}: {
  state: PlannerPeriodState;
  live: string | null;
  saving: boolean;
  rewriteRate: number | null;
  strings: PlannerPeriodStrings;
  onWrite: () => void;
  onStop: () => void;
  onEdit: (memo: string) => void;
  onSave: () => void;
}) {
  const goalsStrings = usePlannerGoalsStrings();
  const [preview, setPreview] = useState(false);
  const writing = live !== null;
  return (
    <Panel testId="planner-period-memo" title={strings.memoTitle}>
      <p className="text-xs text-muted-foreground">{strings.memoHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        {writing ? (
          <Button size="sm" variant="outline" onClick={onStop}>
            {strings.stop}
          </Button>
        ) : (
          <Button
            data-testid="planner-period-write-memo"
            size="sm"
            variant={state.memo ? "outline" : "default"}
            onClick={onWrite}
          >
            {state.memo ? strings.writeAgain : strings.writeMemo}
          </Button>
        )}
        {state.memo && !writing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? "Edit" : "Preview"}
          </Button>
        )}
        {rewriteRate !== null && (
          <PlannerBadge tone="neutral">
            {strings.rewriteRate(Math.round(rewriteRate * 100))}
          </PlannerBadge>
        )}
        {state.memo && !writing && (
          <Button
            className="ml-auto"
            data-testid="planner-period-save"
            disabled={saving || state.memoSaved}
            size="sm"
            onClick={onSave}
          >
            {saving
              ? strings.saving
              : state.memoSaved
                ? strings.saved
                : strings.save}
          </Button>
        )}
      </div>
      {writing && (
        <div className="rounded-lg border border-border p-3">
          <PlannerMarkdown
            diaryLabel={(from, to) =>
              goalsStrings.range(
                {
                  month: Number(from.slice(5, 7)) - 1,
                  day: Number(from.slice(8, 10)),
                },
                {
                  month: Number(to.slice(5, 7)) - 1,
                  day: Number(to.slice(8, 10)),
                },
              )
            }
            live
            markdown={live || strings.writing}
          />
        </div>
      )}
      {!writing &&
        state.memo &&
        (preview ? (
          <div className="rounded-lg border border-border p-3">
            <PlannerMarkdown
              diaryLabel={(from, to) =>
                goalsStrings.range(
                  {
                    month: Number(from.slice(5, 7)) - 1,
                    day: Number(from.slice(8, 10)),
                  },
                  {
                    month: Number(to.slice(5, 7)) - 1,
                    day: Number(to.slice(8, 10)),
                  },
                )
              }
              markdown={state.memo}
            />
          </div>
        ) : (
          <Textarea
            className="min-h-[360px] font-mono text-[13px]"
            data-testid="planner-period-memo-text"
            value={state.memo}
            onChange={(event) => onEdit(event.target.value)}
          />
        ))}
    </Panel>
  );
}

function WeeksTable({
  review,
  strings,
}: {
  review: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
}) {
  const score = (value: number | null) =>
    value === null ? "–" : plannerFormatScore(value);
  return (
    <Panel testId="planner-period-weeks" title={strings.weeksTable}>
      <div className="grid grid-cols-[auto_auto_auto_auto_auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs tabular-nums">
        <span className="text-muted-foreground">{strings.week}</span>
        <span className="text-muted-foreground">A/A</span>
        <span className="text-muted-foreground">{strings.entries}</span>
        <span className="text-muted-foreground">{strings.health}</span>
        <span className="text-muted-foreground">{strings.tasks}</span>
        <span className="text-muted-foreground">{strings.summary}</span>
        {review.weeks.map((week) => (
          <WeekRow
            key={week.week_start}
            score={score}
            strings={strings}
            week={week}
          />
        ))}
      </div>
    </Panel>
  );
}

function WeekRow({
  week,
  score,
  strings,
}: {
  week: PlannerPeriodReviewResponse["weeks"][number];
  score: (value: number | null) => string;
  strings: PlannerPeriodStrings;
}) {
  return (
    <>
      <span className="font-mono text-muted-foreground">W{week.number}</span>
      <span>
        {score(week.auth)}/{score(week.ach)}
      </span>
      <span>{week.entries}</span>
      <span>{week.health_rows}</span>
      <span>{week.tasks_done}</span>
      <span className="truncate">
        {week.memo_id ? (
          <Link
            className="underline"
            params={{ memoId: week.memo_id }}
            to="/memo/$memoId"
          >
            {strings.summary}
          </Link>
        ) : (
          <span className="text-muted-foreground">{strings.noSummary}</span>
        )}
      </span>
    </>
  );
}

function Receipts({
  evidence,
  saved,
  strings,
  onAdd,
  onRemove,
}: {
  evidence: PlannerPeriodState["evidence"];
  saved: PlannerPeriodReviewResponse["evidence"];
  strings: PlannerPeriodStrings;
  onAdd: (claim: string, quote: string, pillar: PlannerPillar | null) => void;
  onRemove: (index: number) => void;
}) {
  const [claim, setClaim] = useState("");
  const [quote, setQuote] = useState("");
  const [pillar, setPillar] = useState<PlannerPillar | null>(null);
  const savedByQuote = new Map(
    saved.map((item) => [`${item.claim}\n${item.quote}`, item]),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!claim.trim() || !quote.trim()) return;
    onAdd(claim.trim(), quote.trim(), pillar);
    setClaim("");
    setQuote("");
  };
  return (
    <Panel testId="planner-period-receipts" title={strings.receipts}>
      <p className="text-xs text-muted-foreground">{strings.receiptsHint}</p>
      {evidence.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {evidence.map((item, index) => {
            const known = savedByQuote.get(`${item.claim}\n${item.quote}`);
            return (
              <li
                className="flex flex-col gap-0.5 rounded-lg border border-border p-2 text-sm"
                // biome-ignore lint/suspicious/noArrayIndexKey: an ordered list without ids
                key={`${index}-${item.claim.slice(0, 12)}`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  {item.pillar && (
                    <PlannerBadge tone="brand">{item.pillar}</PlannerBadge>
                  )}
                  {known ? (
                    <Verified strings={strings} verified={known.verified} />
                  ) : null}
                  <button
                    className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                    type="button"
                    onClick={() => onRemove(index)}
                  >
                    {strings.removeReceipt}
                  </button>
                </div>
                <span>{item.claim}</span>
                <q className="text-muted-foreground">{item.quote}</q>
              </li>
            );
          })}
        </ul>
      )}
      <form className="flex flex-col gap-1.5" onSubmit={submit}>
        <input
          className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
          data-testid="planner-period-receipt-claim"
          placeholder={strings.claim}
          value={claim}
          onChange={(event) => setClaim(event.target.value)}
        />
        <input
          className="h-8 rounded-lg border border-border bg-background px-2 text-sm"
          data-testid="planner-period-receipt-quote"
          placeholder={strings.quote}
          value={quote}
          onChange={(event) => setQuote(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <PlannerChoice
            label={strings.claim}
            options={plannerPillars.map((value) => ({ value, label: value }))}
            value={pillar}
            onChange={(value) => setPillar(value === pillar ? null : value)}
          />
          <Button
            className="ml-auto"
            data-testid="planner-period-receipt-add"
            size="sm"
            type="submit"
            variant="outline"
          >
            {strings.addReceipt}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function PreviousForecast({
  review,
  strings,
}: {
  review: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
}) {
  if (!review.previous) return null;
  return (
    <Panel title={strings.previousForecast}>
      {review.previous.forecast ? (
        <q className="text-sm">{review.previous.forecast}</q>
      ) : (
        <p className="text-sm text-muted-foreground">
          {strings.noPreviousForecast}
        </p>
      )}
      {review.previous.forecast_grade && (
        <PlannerBadge
          tone={
            review.previous.forecast_grade === "held"
              ? "met"
              : review.previous.forecast_grade === "partly"
                ? "partial"
                : "missed"
          }
        >
          {strings.grade[review.previous.forecast_grade]}
        </PlannerBadge>
      )}
    </Panel>
  );
}
