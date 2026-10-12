import {
  type PlannerBoardResponse,
  type PlannerCommitInput,
  type PlannerGoalFlagDto,
  type PlannerPillar,
  type PlannerReviewResponse,
  plannerPillars,
  plannerTodoCap,
} from "@flaremo/contracts";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PlannerPillarLabel, plannerPillarClass } from "./goal-cards";
import { plannerGoalText, plannerWeekNumber } from "./goals-model";
import type { PlannerGoalsStrings } from "./goals-strings";
import { PlannerBadge, PlannerChoice } from "./goals-ui";
import {
  type PlannerForwardState,
  type PlannerPlanGoal,
  plannerNamedGoals,
  plannerOtherTodo,
  plannerPickableCards,
  plannerTodoCount,
} from "./review-model";

// Look forward, the second part of the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md), in four steps: settle the clashes the
// last conflict check found, choose the week's goals, plan their tasks under the
// To Do cap, and commit with the question for next Sunday after a conflict check
// that only flags. The page owns the state and the saves; this file draws them.

/** The conflict check of the plan as it stands. */
export type PlannerCheck = {
  /** The plan it checked (plannerPlanSignature). */
  sig: string;
  status: "running" | "done" | "off" | "failed";
  flags: PlannerCommitInput["flags"];
};

export type PlannerForwardActions = {
  goStep: (step: number) => void;
  keep: (flagId: string) => void;
  rewrite: (flagId: string, title: string) => void;
  undo: (flagId: string) => void;
  setGoalTitle: (goalId: string, title: string) => void;
  setGoalPillar: (goalId: string, pillar: PlannerPillar) => void;
  removeGoal: (goalId: string) => void;
  addGoal: () => void;
  toggleBacklog: (cardId: string) => void;
  addNewTask: (goalId: string, title: string) => void;
  addBoardTask: (goalId: string, cardId: string) => void;
  removeTask: (ref: string) => void;
  setQuestion: (question: string) => void;
  save: () => void;
};

type Props = {
  review: PlannerReviewResponse;
  forward: PlannerForwardState;
  board: PlannerBoardResponse | undefined;
  step: number;
  question: string;
  check: PlannerCheck | null;
  saving: boolean;
  /** Look forward was saved before. */
  saved: boolean;
  strings: PlannerGoalsStrings;
  actions: PlannerForwardActions;
};

/**
 * A step's title. It takes focus when its step opens, so a step reached from
 * the buttons at the bottom of the last one is read, and seen, from the top.
 */
function StepTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const heading = ref.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <h2
      className="mb-4 flex scroll-mt-28 flex-wrap items-center gap-2.5 text-xl font-semibold outline-none"
      ref={ref}
      tabIndex={-1}
    >
      {children}
    </h2>
  );
}
const LINE =
  "grid gap-x-3 gap-y-0.5 text-sm leading-snug sm:grid-cols-[120px_1fr]";
const LINE_LABEL = "pt-0.5 font-mono text-xs text-muted-foreground";
const FIELD =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30";

function pillarName(
  pillar: PlannerPillar | null,
  strings: PlannerGoalsStrings,
) {
  return pillar ? strings.pillar[pillar] : strings.noPillar;
}

// --- Step 1: Check goals -------------------------------------------------------

function FlagCard({ flag, props }: { flag: PlannerGoalFlagDto; props: Props }) {
  const { review, forward, strings, actions } = props;
  const text = strings.review.forward;
  const fieldId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const goals = new Map(review.flag_goals.map((goal) => [goal.id, goal]));
  const withGoal = flag.with_goal_id ? goals.get(flag.with_goal_id) : undefined;
  const ownGoal = flag.goal_id ? goals.get(flag.goal_id) : undefined;
  const target = withGoal ?? ownGoal;
  const settled = forward.settled[flag.id];

  return (
    <article
      className={cn(
        "mb-3 flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5",
        plannerPillarClass(flag.pillar),
      )}
      data-testid="planner-clash"
    >
      <div className="flex items-center gap-2.5">
        <PlannerPillarLabel pillar={flag.pillar} strings={strings} />
        <span className="ml-auto">
          {settled?.state === "kept" ? (
            <PlannerBadge>{text.kept}</PlannerBadge>
          ) : settled?.state === "rewritten" ? (
            <PlannerBadge tone="met">
              <span aria-hidden="true" className="text-[11px]">
                ✓
              </span>
              {text.rewritten}
            </PlannerBadge>
          ) : (
            <PlannerBadge tone="contested">{text.clash}</PlannerBadge>
          )}
        </span>
      </div>
      <p className="leading-snug font-semibold">{flag.why}</p>
      <div className="flex flex-col gap-1.5">
        <div className={LINE}>
          <span className={LINE_LABEL}>{flag.with_label}</span>
          <span>{withGoal ? plannerGoalText(withGoal) : ""}</span>
        </div>
        {ownGoal && (
          <div className={LINE}>
            <span className={LINE_LABEL}>
              {strings.weekCode(plannerWeekNumber(flag.week_start))}
            </span>
            <span>{plannerGoalText(ownGoal)}</span>
          </div>
        )}
      </div>
      {draft !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) return;
            actions.rewrite(flag.id, draft.trim());
            setDraft(null);
          }}
        >
          <label className="mt-1 text-sm font-semibold" htmlFor={fieldId}>
            {flag.with_label}
          </label>
          <Textarea
            autoFocus
            className="min-h-20"
            id={fieldId}
            maxLength={1000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={!draft.trim()} size="sm" type="submit">
              {text.save}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setDraft(null)}
            >
              {text.cancel}
            </Button>
          </div>
        </form>
      ) : settled ? (
        <>
          {settled.state === "rewritten" && settled.title && (
            <div className={LINE}>
              <span className={LINE_LABEL}>{text.now}</span>
              <span>{settled.title}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => actions.undo(flag.id)}
            >
              {text.undo}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          {target && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft(plannerGoalText(target))}
            >
              {text.rewrite}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.keep(flag.id)}
          >
            {text.keep}
          </Button>
        </div>
      )}
    </article>
  );
}

function CheckGoals(props: Props) {
  const { review, forward, strings } = props;
  const text = strings.review.forward;
  const open = review.flags.filter((flag) => !forward.settled[flag.id]).length;
  return (
    <>
      <StepTitle>
        {text.steps[0]}
        {review.flags.length === 0 ? null : open ? (
          <PlannerBadge tone="contested">{text.open(open)}</PlannerBadge>
        ) : (
          <PlannerBadge tone="met">
            <span aria-hidden="true" className="text-[11px]">
              ✓
            </span>
            {text.settled}
          </PlannerBadge>
        )}
      </StepTitle>
      {review.flags.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <span aria-hidden="true">✓</span>
          {text.noClashes}
        </p>
      ) : (
        review.flags.map((flag) => (
          <FlagCard flag={flag} key={flag.id} props={props} />
        ))
      )}
    </>
  );
}

// --- Step 2: Choose the week ---------------------------------------------------------

function GoalSlot({ goal, props }: { goal: PlannerPlanGoal; props: Props }) {
  const { strings, actions } = props;
  const text = strings.review.forward;
  return (
    <div
      className={cn(
        "planner-slot flex min-w-0 flex-col gap-2.5 rounded-xl px-3.5 py-3",
        plannerPillarClass(goal.pillar),
      )}
      data-testid="planner-plan-slot"
    >
      <div className="flex items-center gap-2">
        <PlannerPillarLabel pillar={goal.pillar} strings={strings} />
        {goal.fromSummary && (
          <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
            {text.fromSummary(
              strings.weekCode(plannerWeekNumber(goal.fromSummary)),
            )}
          </span>
        )}
        <Button
          aria-label={text.removeGoal}
          className={cn(
            "text-muted-foreground",
            !goal.fromSummary && "ml-auto",
          )}
          size="icon-sm"
          variant="ghost"
          onClick={() => actions.removeGoal(goal.id)}
        >
          <XIcon />
        </Button>
      </div>
      {goal.custom && (
        <PlannerChoice
          label={strings.editor.objective}
          options={plannerPillars.map((pillar) => ({
            value: pillar,
            className: plannerPillarClass(pillar),
            label: (
              <>
                <i aria-hidden="true" className="planner-dot" />
                {strings.pillarShort[pillar]}
              </>
            ),
          }))}
          value={goal.pillar}
          onChange={(pillar) => actions.setGoalPillar(goal.id, pillar)}
        />
      )}
      <Textarea
        aria-label={text.goalFor(pillarName(goal.pillar, strings))}
        className="min-h-16 bg-background"
        maxLength={1000}
        placeholder={text.goalPlaceholder}
        value={goal.title}
        onChange={(event) => actions.setGoalTitle(goal.id, event.target.value)}
      />
    </div>
  );
}

function ChooseWeek(props: Props) {
  const { forward, strings, actions } = props;
  const text = strings.review.forward;
  return (
    <>
      <StepTitle>{text.steps[1]}</StepTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {forward.goals.map((goal) => (
          <GoalSlot goal={goal} key={goal.id} props={props} />
        ))}
      </div>
      <div className="mt-3">
        <Button
          disabled={forward.goals.length >= 12}
          variant="outline"
          onClick={actions.addGoal}
        >
          {text.addGoal}
        </Button>
      </div>
    </>
  );
}

// --- Step 3: Plan tasks --------------------------------------------------------------

function NewTaskForm({
  label,
  full,
  strings,
  onAdd,
}: {
  label: string;
  full: boolean;
  strings: PlannerGoalsStrings;
  onAdd: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (full || !title.trim()) return;
    onAdd(title);
    setTitle("");
  };
  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
      onSubmit={submit}
    >
      <Input
        aria-label={label}
        autoComplete="off"
        className="h-8"
        disabled={full}
        maxLength={2000}
        placeholder={strings.review.forward.newTask}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Button
        disabled={full || !title.trim()}
        size="sm"
        type="submit"
        variant="outline"
      >
        {strings.review.forward.add}
      </Button>
    </form>
  );
}

function BoardPickForm({
  label,
  full,
  pickable,
  strings,
  onAdd,
}: {
  label: string;
  full: boolean;
  pickable: ReturnType<typeof plannerPickableCards>;
  strings: PlannerGoalsStrings;
  onAdd: (cardId: string) => void;
}) {
  const [cardId, setCardId] = useState("");
  const text = strings.review.forward;
  // A card from Backlog adds to To Do, so it waits while To Do is full; a card
  // already in To Do or Doing does not.
  const groups = [
    { label: text.todo, cards: pickable.todo },
    { label: text.backlog, cards: full ? [] : pickable.backlog },
    { label: text.source.doing, cards: pickable.doing },
  ].filter((group) => group.cards.length > 0);
  const known = groups.some((group) =>
    group.cards.some((card) => card.id === cardId),
  );
  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!known) return;
        onAdd(cardId);
        setCardId("");
      }}
    >
      <select
        aria-label={label}
        className={cn(FIELD, "truncate")}
        value={known ? cardId : ""}
        onChange={(event) => setCardId(event.target.value)}
      >
        <option value="">{text.fromBoard}</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.cards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <Button disabled={!known} size="sm" type="submit" variant="outline">
        {text.add}
      </Button>
    </form>
  );
}

function PlanTasks(props: Props) {
  const { forward, board, strings, actions } = props;
  const text = strings.review.forward;
  const heading = <StepTitle>{text.steps[2]}</StepTitle>;
  if (!board) {
    return (
      <>
        {heading}
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </>
    );
  }
  const count = plannerTodoCount(forward, board);
  const full = count >= plannerTodoCap;
  const named = plannerNamedGoals(forward);
  const others = plannerOtherTodo(forward, board);
  const moved = new Set(forward.toBacklog);
  const pickable = plannerPickableCards(forward, board);

  return (
    <>
      {heading}
      <div className="-mt-1.5 mb-3 flex justify-end gap-2.5 text-[13px] text-muted-foreground">
        <span>{text.todo}</span>
        <span
          className={cn("font-mono tabular-nums", full && "text-warning")}
          data-testid="planner-plan-todo-count"
        >
          {count}/{plannerTodoCap}
        </span>
      </div>
      <div className="flex flex-col gap-3.5">
        {others.length > 0 && (
          <div className="flex flex-col gap-2.5 rounded-xl border border-border px-3.5 py-3">
            <span className="text-[13px] text-muted-foreground">
              {text.inTodo}
            </span>
            <div className="flex flex-col gap-1.5">
              {others.map((card) => {
                const isMoved = moved.has(card.id);
                return (
                  <div
                    className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-2.5 py-1.5"
                    key={card.id}
                  >
                    <span
                      className={cn(
                        "min-w-0 flex-1 text-sm [overflow-wrap:anywhere]",
                        isMoved && "text-muted-foreground line-through",
                      )}
                    >
                      {card.title}
                    </span>
                    {isMoved && (
                      <span className="text-xs whitespace-nowrap text-muted-foreground">
                        {text.toBacklog}
                      </span>
                    )}
                    <Button
                      className="flex-none"
                      size="sm"
                      variant="outline"
                      onClick={() => actions.toggleBacklog(card.id)}
                    >
                      {isMoved ? text.undo : text.toBacklog}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {named.length === 0 ? (
          <p className="text-sm text-muted-foreground">{text.noGoals}</p>
        ) : (
          named.map((goal) => {
            const mine = forward.tasks.filter(
              (task) => task.goal_id === goal.id,
            );
            const name = pillarName(goal.pillar, strings);
            return (
              <div
                className={cn(
                  "flex flex-col gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3",
                  plannerPillarClass(goal.pillar),
                )}
                data-testid="planner-plan-goal"
                key={goal.id}
              >
                <div className="flex items-baseline gap-2.5">
                  <i aria-hidden="true" className="planner-dot" />
                  <span className="leading-snug font-medium">{goal.title}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {mine.length === 0 ? (
                    <span className="text-[13px] text-muted-foreground">
                      {text.noTasks}
                    </span>
                  ) : (
                    mine.map((task) => (
                      <div
                        className="planner-plan-task flex items-center gap-2.5 rounded-[10px] px-2.5 py-1.5"
                        key={task.ref}
                      >
                        <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
                          {task.title}
                        </span>
                        <span className="text-xs whitespace-nowrap text-muted-foreground">
                          {text.source[task.source]}
                        </span>
                        <Button
                          aria-label={text.removeTask}
                          className="text-muted-foreground"
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => actions.removeTask(task.ref)}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
                <NewTaskForm
                  full={full}
                  label={text.newTaskFor(name)}
                  strings={strings}
                  onAdd={(title) => actions.addNewTask(goal.id, title)}
                />
                <BoardPickForm
                  full={full}
                  label={text.fromBoardFor(name)}
                  pickable={pickable}
                  strings={strings}
                  onAdd={(cardId) => actions.addBoardTask(goal.id, cardId)}
                />
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// --- Step 4: Commit ----------------------------------------------------------

function Commit(props: Props) {
  const { forward, question, check, strings, actions } = props;
  const text = strings.review.forward;
  const fieldId = useId();
  const named = plannerNamedGoals(forward);
  const goalsById = new Map(forward.goals.map((goal) => [goal.id, goal]));
  return (
    <>
      <StepTitle>{text.steps[3]}</StepTitle>
      <div className="flex flex-col gap-3">
        {named.length === 0 ? (
          <p className="text-sm text-muted-foreground">{text.noGoals}</p>
        ) : (
          named.map((goal) => {
            const mine = forward.tasks.filter(
              (task) => task.goal_id === goal.id,
            );
            return (
              <div
                className="grid gap-x-3 gap-y-1.5 rounded-xl border border-border bg-card px-3.5 py-3 sm:grid-cols-[150px_1fr]"
                key={goal.id}
              >
                <PlannerPillarLabel pillar={goal.pillar} strings={strings} />
                <div className="min-w-0">
                  <div className="leading-snug">{goal.title}</div>
                  {mine.length > 0 && (
                    <ul className="mt-1.5 list-disc pl-[18px] text-[13px] text-muted-foreground">
                      {mine.map((task) => (
                        <li key={task.ref}>{task.title}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div>
          <label className="mt-1.5 mb-2 block font-semibold" htmlFor={fieldId}>
            {strings.review.nextQuestion}
          </label>
          <Input
            id={fieldId}
            maxLength={500}
            value={question}
            onChange={(event) => actions.setQuestion(event.target.value)}
          />
        </div>
        <section
          aria-live="polite"
          className="flex flex-col gap-2"
          data-testid="planner-conflict-check"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-medium tracking-[0.07em] text-muted-foreground uppercase">
              {text.check}
            </span>
            {check?.status === "running" && (
              <span className="planner-thinking text-[13px] text-muted-foreground">
                {text.checking}
              </span>
            )}
            {check?.status === "done" && (
              <PlannerBadge>{text.model}</PlannerBadge>
            )}
          </div>
          {check?.status === "off" && (
            <p className="text-sm text-muted-foreground">{text.noCheck}</p>
          )}
          {check?.status === "failed" && (
            <p className="text-sm text-muted-foreground">{text.checkFailed}</p>
          )}
          {check?.status === "done" &&
            (check.flags.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-success">
                <span aria-hidden="true">✓</span>
                {text.noFlags}
              </p>
            ) : (
              check.flags.map((flag) => {
                const goal = flag.goal_id
                  ? goalsById.get(flag.goal_id)
                  : undefined;
                const pillar = goal?.pillar ?? flag.pillar;
                return (
                  <div
                    className="grid grid-cols-[20px_1fr] items-start gap-2.5 rounded-xl border border-warning/45 bg-warning/10 px-3 py-2.5 sm:grid-cols-[20px_1fr_auto]"
                    data-testid="planner-check-flag"
                    key={`${flag.with_label}-${flag.why}`}
                  >
                    <span aria-hidden="true" className="font-bold text-warning">
                      !
                    </span>
                    <div className="text-sm leading-snug">
                      {pillar && (
                        <PlannerPillarLabel
                          className="mr-1.5 align-baseline"
                          pillar={pillar}
                          short
                          strings={strings}
                        />
                      )}
                      <span>{flag.why}</span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground max-sm:col-start-2">
                      {flag.with_label}
                    </span>
                  </div>
                );
              })
            ))}
        </section>
      </div>
    </>
  );
}

// --- The four steps ------------------------------------------------------------

export function PlannerLookForward(props: Props) {
  const { step, saving, saved, strings, actions } = props;
  const text = strings.review.forward;
  const steps = text.steps;
  return (
    <div className="max-w-[880px]">
      <nav
        aria-label={strings.review.lookForward}
        className="mb-4.5 flex flex-wrap gap-1.5"
      >
        {steps.map((name, index) => {
          const number = index + 1;
          const current = number === step;
          const done = number < step || (saved && !current);
          return (
            <button
              aria-current={current ? "step" : undefined}
              className={cn(
                "inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-full border border-border bg-card px-3 text-[13px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                current && "border-foreground text-foreground",
                done && "text-foreground",
              )}
              key={name}
              type="button"
              onClick={() => actions.goStep(number)}
            >
              <span className={cn("font-mono text-xs", done && "text-success")}>
                {done ? "✓" : number}
              </span>
              {name}
            </button>
          );
        })}
      </nav>
      <section data-testid="planner-forward-step">
        {step === 1 && <CheckGoals {...props} />}
        {step === 2 && <ChooseWeek {...props} />}
        {step === 3 && <PlanTasks {...props} />}
        {step === 4 && <Commit {...props} />}
        <div className="mt-5.5 flex justify-between gap-2.5 border-t border-border pt-4">
          {step === 1 ? (
            <Button
              render={<Link search={{ part: "back" }} to="/weekly-review" />}
              variant="outline"
            >
              {text.lookBack}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => actions.goStep(step - 1)}>
              {text.backTo(steps[step - 2] ?? "")}
            </Button>
          )}
          {step < 4 ? (
            <Button onClick={() => actions.goStep(step + 1)}>
              {text.nextTo(steps[step] ?? "")}
            </Button>
          ) : (
            <Button
              data-testid="planner-save-week"
              disabled={saving}
              onClick={actions.save}
            >
              {saving ? text.saving : text.saveWeek}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
