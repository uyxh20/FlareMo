import type {
  PlannerAiMemoInput,
  PlannerPeriodHappened,
  PlannerPeriodOpeningResponse,
  PlannerPeriodReviewResponse,
} from "@flaremo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { plannerErrorMessage } from "./api";
import { PlannerPillarLabel } from "./goal-cards";
import {
  plannerAiClose,
  plannerAiFailure,
  plannerAiOpening,
  plannerStreamCoach,
  plannerStreamMemo,
} from "./goals-api";
import {
  type PlannerGoalsStrings,
  usePlannerGoalsStrings,
} from "./goals-strings";
import {
  plannerSavePeriodRequest,
  plannerSavePeriodStateRequest,
} from "./period-api";
import {
  type PlannerPeriodChatState,
  plannerPeriodChatBase,
  plannerPeriodChatReview,
  plannerPeriodChatSaveInput,
  plannerPeriodChatTemplate,
  plannerPeriodStats,
  plannerRestorePeriodChat,
} from "./period-chat-model";
import type { PlannerPeriodStrings } from "./period-strings";
import { plannerQueryKeys } from "./query-keys";
import { PlannerLookBack } from "./review-back";
import {
  type PlannerBackState,
  plannerAddAnswer,
  plannerAddCoachReply,
  plannerAddProbe,
  plannerAdvance,
  plannerAnswersInput,
  plannerCoachMessages,
  plannerCoachMode,
  plannerDraftsOf,
  plannerFallbackDrafts,
  plannerMemoDrafts,
  plannerMergeClose,
  plannerMergeOpening,
  plannerOpenQuestions,
  plannerOpenScores,
  plannerStepScore,
  plannerSysOnce,
} from "./review-model";
import { PlannerMemoSheet } from "./review-sheet";

// The month, quarter and year chapters of the review (fork-owned add-on,
// docs/planning-cockpit-period-review.md): the weekly review's Look back chat
// over a bigger period, the owner's decision of 17 October 2026. The same
// steps (last period's question, the period's goals, the seven prompts, the
// scores, the next question, the verdict, the memo) and the same chat
// (review-back.tsx), run on the period's own routes, which answer the weekly
// ones in kind. Two things are added: what the review reads, counted, before
// it starts, and what happened in the period under the recap, where every
// claim carries the owner's own words, found and checked by the server.
// There is nothing to grade, enter or forecast by hand. review-page.tsx renders
// it as the chapter between Look back and Look forward.

const SAVE_DELAY = 800;

function agentSession(back: PlannerBackState): { session?: string } {
  return back.agent ? { session: back.agent } : {};
}

/** The weekly chat's words, said of the period; `next` names the chapter after it. */
function chatStrings(
  goals: PlannerGoalsStrings,
  period: PlannerPeriodStrings,
  word: string,
  label: string,
  next: string,
): PlannerGoalsStrings {
  const chat = period.chat;
  return {
    ...goals,
    review: {
      ...goals.review,
      start: chat.start(word),
      drafting: chat.drafting(word),
      draftingAgent: chat.draftingAgent(word),
      scoring: chat.scoring(word),
      lastQuestion: chat.lastQuestion(word),
      lastGoals: chat.goalsOf(label),
      nextQuestion: chat.nextQuestion(word),
      summaryTitle: chat.summaryTitle,
      writeSummary: chat.writeSummary,
      openSummary: chat.openSummary,
      toLookForward: next,
      lastQuestionItem: chat.lastQuestion(word),
      lastGoalsItem: chat.goalsItem(word),
      nextQuestionItem: chat.nextQuestionItem(word),
      memo: {
        ...goals.review.memo,
        title: chat.memoTitle,
        label: chat.memoLabel,
        writingAgent: chat.draftingAgent(word),
        savedToast: chat.savedToast,
      },
    },
  };
}

function Stats({
  period,
  strings,
}: {
  period: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
}) {
  const stats = plannerPeriodStats(period);
  const items = [
    strings.chat.entries(stats.entries),
    strings.chat.memos(stats.memos),
    strings.chat.tasksDone(stats.tasksDone),
    strings.chat.goals(stats.goals),
  ];
  return (
    <div
      className="flex flex-col items-center gap-2"
      data-testid="planner-period-stats"
    >
      <span className="text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase">
        {strings.chat.reads}
      </span>
      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {items.map((item) => (
          <li
            className="rounded-[10px] border border-border bg-background px-3 py-2 text-sm tabular-nums"
            key={item}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Happened({
  happened,
  dropped,
  label,
  strings,
  goalsStrings,
}: {
  happened: readonly PlannerPeriodHappened[];
  dropped: number;
  label: string;
  strings: PlannerPeriodStrings;
  goalsStrings: PlannerGoalsStrings;
}) {
  return (
    <div
      className="flex max-w-[600px] flex-col gap-2 rounded-xl border border-border bg-background px-3.5 py-3"
      data-testid="planner-period-happened"
    >
      <span className="text-[13px] font-semibold">
        {strings.chat.happened(label)}
      </span>
      {happened.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {strings.chat.nothingBacked}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {happened.map((entry) => (
            <li
              className="flex flex-col gap-0.5 leading-snug"
              key={`${entry.claim}:${entry.source_id}`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                {entry.pillar && (
                  <PlannerPillarLabel
                    pillar={entry.pillar}
                    short
                    strings={goalsStrings}
                  />
                )}
                <span>{entry.claim}</span>
              </span>
              <span className="text-[12.5px] text-success">
                ✓ {entry.source_day} · {strings.chat.sources[entry.source]}:{" "}
                <q className="text-muted-foreground">{entry.quote}</q>
              </span>
            </li>
          ))}
        </ul>
      )}
      {dropped > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          {strings.chat.dropped(dropped)}
        </p>
      )}
    </div>
  );
}

export function PlannerPeriodChat({
  period,
  strings: periodStrings,
  today,
  next,
  onSaved,
}: {
  period: PlannerPeriodReviewResponse;
  strings: PlannerPeriodStrings;
  today: string;
  /** The chapter after this one: its button label, and what opens it. */
  next: { label: string; go: () => void };
  onSaved: (doneAt: string) => void;
}) {
  const goalsStrings = usePlannerGoalsStrings();
  const queryClient = useQueryClient();
  const { level, period_start: periodStart, label } = period;
  const word = level;
  const base = plannerPeriodChatBase(level, periodStart);
  const review = useMemo(
    () => plannerPeriodChatReview(period, today),
    [period, today],
  );
  const strings = useMemo(
    () => chatStrings(goalsStrings, periodStrings, word, label, next.label),
    [goalsStrings, periodStrings, word, label, next.label],
  );

  // --- The review's state, saved as it changes -----------------------------

  const [state, setState] = useState<PlannerPeriodChatState>(() =>
    plannerRestorePeriodChat(period.state, review),
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
          cached?.level === level && cached.period_start === periodStart
            ? { ...cached, state: saving }
            : cached,
      );
      try {
        await plannerSavePeriodStateRequest(level, periodStart, saving, {
          keepalive,
        });
      } catch {
        dirty.current = true;
      }
    },
    [level, periodStart, queryClient, today],
  );

  const update = useCallback(
    (change: (current: PlannerPeriodChatState) => PlannerPeriodChatState) => {
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

  const { back } = state;
  const [savedAt, setSavedAt] = useState(period.done_at);
  const lookBackDone = back.memoSaved || Boolean(savedAt);
  const drafts = plannerDraftsOf(back, review);
  const failureNote = (kind: "unavailable" | "limited" | "failed") =>
    kind === "limited" ? strings.review.modelLimited : strings.review.modelDown;

  // --- The chat ----------------------------------------------------------------

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [live, setLive] = useState<string | null>(null);

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
    const fallback = plannerFallbackDrafts(review);
    const baseDrafts = {
      ...fallback,
      recap: periodStrings.chat.fallbackRecap(review.week_goals.length, word),
    };
    let ai: PlannerPeriodOpeningResponse | null = null;
    let note: string | null = review.ai ? null : strings.review.noModel;
    if (review.ai) {
      try {
        const session = stateRef.current.back.agent ?? undefined;
        ai = (
          await plannerAiOpening(
            base,
            { today, ...(session ? { session } : {}) },
            {
              onAgent: (agent) => {
                if (alive.current) {
                  setBack((current) => ({ ...current, agent }));
                }
              },
            },
          )
        ).opening as PlannerPeriodOpeningResponse;
      } catch (error) {
        const kind = plannerAiFailure(error);
        note = failureNote(kind);
        modelFailed(kind);
      }
    }
    if (!alive.current) return;
    update((current) => {
      if (current.back.stage !== "drafting") return current;
      const noted = note ? plannerSysOnce(current.back, note) : current.back;
      return {
        ...current,
        happened: ai ? (ai.happened ?? []) : null,
        dropped: ai?.dropped ?? 0,
        back: plannerOpenQuestions(
          noted,
          review,
          plannerMergeOpening(baseDrafts, ai),
        ),
      };
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
          await plannerAiClose(base, {
            today,
            ...plannerAnswersInput(current, review),
            ...agentSession(current),
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

  const coach = async (
    mode: "free" | "force" | "chat",
  ): Promise<{ advance: boolean } | null> => {
    const controller = new AbortController();
    coachAbort.current = controller;
    busyRef.current = true;
    setBusy(true);
    setLive("");
    const result = await plannerStreamCoach(
      base,
      {
        today,
        mode,
        messages: plannerCoachMessages(stateRef.current.back),
        ...agentSession(stateRef.current.back),
      },
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

  // --- The memo ------------------------------------------------------------------

  const [sheetOpen, setSheetOpen] = useState(false);
  const [memoLive, setMemoLive] = useState<string | null>(null);
  const [memoAgent, setMemoAgent] = useState(false);
  const [memoSaving, setMemoSaving] = useState(false);
  const [memoSaveFailed, setMemoSaveFailed] = useState(false);

  const save = async (memo: string) => {
    setMemoSaving(true);
    setMemoSaveFailed(false);
    try {
      const saved = await plannerSavePeriodRequest(
        level,
        periodStart,
        plannerPeriodChatSaveInput({
          state: stateRef.current,
          review,
          today,
          memo,
        }),
      );
      if (!alive.current) return;
      setBack((current) => ({ ...current, memoSaved: true }));
      await flush();
      setSavedAt(saved.done_at);
      onSaved(saved.done_at);
      toast.success(strings.review.memo.savedToast);
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.periodStatus(today),
      });
      void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.goals });
    } catch (failure) {
      if (!alive.current) return;
      setMemoSaveFailed(true);
      toast.error(
        plannerErrorMessage(
          failure,
          strings.review.memo.saveFailed,
          periodStrings.limited,
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
    const happened = stateRef.current.happened ?? [];
    const template = () =>
      plannerPeriodChatTemplate({
        period,
        back: current,
        review,
        happened,
        today,
      });
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
      const written = plannerDraftsOf(current, review);
      const request: PlannerAiMemoInput & {
        happened: PlannerPeriodHappened[];
      } = {
        today,
        ...plannerAnswersInput(current, review),
        ...agentSession(current),
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
        recommended: written.trajectory.recommended ?? "continue",
        drafts: plannerMemoDrafts(written),
        drafted:
          written.scores.auth_evidence || written.scores.ach_evidence
            ? { auth: written.scores.auth, ach: written.scores.ach }
            : null,
        happened: happened.slice(0, 16),
      };
      const result = await plannerStreamMemo(base, request, {
        signal: controller.signal,
        onText: (text) => {
          if (alive.current) setMemoLive(text);
        },
        onAgent: () => {
          if (alive.current) setMemoAgent(true);
        },
      });
      memoAbort.current = null;
      if (alive.current) setMemoAgent(false);
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
    update((latest) => ({
      ...latest,
      draftMemo: by === "model" ? memo : null,
      back: {
        ...latest.back,
        memo,
        memoBy: by,
        memoStopped: stopped,
        memoSaved: false,
      },
    }));
    if (note) toast(note);
  };

  const editMemo = (memo: string) =>
    setBack((latest) =>
      latest.memo === memo ? latest : { ...latest, memo, memoSaved: false },
    );

  const saveMemo = () => {
    const memo = stateRef.current.back.memo ?? period.memo?.content ?? null;
    if (memo?.trim()) void save(memo);
  };

  // After a period's chapter comes the next one: a bigger period closing with
  // the same week, or the weekly review's Look forward.
  const toLookForward = () => {
    const current = stateRef.current.back;
    if (current.memo && !current.memoSaved) {
      setSheetOpen(true);
      return;
    }
    setSheetOpen(false);
    next.go();
  };

  const actions = {
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
    goalResult: (goalId: string, result: "met" | "partial" | "missed") =>
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

  return (
    <>
      <PlannerLookBack
        actions={actions}
        back={back}
        busy={busy}
        coach={coachOn}
        done={lookBackDone}
        drafts={drafts}
        live={live}
        period={{
          label,
          word,
          start: <Stats period={period} strings={periodStrings} />,
          recap: state.happened ? (
            <Happened
              dropped={state.dropped}
              goalsStrings={goalsStrings}
              happened={state.happened}
              label={label}
              strings={periodStrings}
            />
          ) : undefined,
        }}
        review={review}
        strings={strings}
        writing={memoLive !== null}
      />
      <PlannerMemoSheet
        canWriteAgain={
          review.ai &&
          back.stage === "done" &&
          (back.memoStopped || back.memoBy === "page")
        }
        live={memoLive}
        memo={back.memo ?? period.memo?.content ?? null}
        memoBy={back.memoBy}
        name={label}
        open={sheetOpen}
        saveFailed={memoSaveFailed}
        saved={back.memoSaved || (!back.memo && Boolean(savedAt))}
        saving={memoSaving}
        stopped={back.memoStopped}
        strings={strings}
        waitingForAgent={memoAgent}
        week={review.review_week}
        onClose={() => {
          memoAbort.current?.abort();
          setSheetOpen(false);
        }}
        onEdit={editMemo}
        onLookForward={toLookForward}
        onSave={saveMemo}
        onStop={() => memoAbort.current?.abort()}
        onWriteAgain={() => void writeMemo(true)}
      />
    </>
  );
}
