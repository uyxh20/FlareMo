import {
  type PlannerAgentProposalDto,
  type PlannerAgentProposalsResponse,
  type PlannerBoardCard,
  type PlannerBoardResponse,
  plannerTodoCap,
} from "@flaremo/contracts";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PlannerPillarLabel, plannerPillarClass } from "./goal-cards";
import type { PlannerGoalsStrings } from "./goals-strings";
import { PlannerBadge } from "./goals-ui";
import {
  type PlannerForwardState,
  plannerNamedGoals,
  plannerTodoCount,
} from "./review-model";

// The general agent's proposals in Look forward (fork-owned add-on,
// docs/fork-general-agent.md). After the memo the agent proposes goals and
// tasks for the week being planned; they show here as cards on top of Choose
// the week and under Plan tasks. When nothing was proposed, Look forward asks
// the agent once by itself, from the latest look back and the goals, and
// Suggest asks again. Add puts one into the plan, which the owner still edits
// and saves as before; Dismiss puts it away. Nothing reaches the board or the
// goals until the week is saved.

export type PlannerProposalActions = {
  addGoal: (proposal: PlannerAgentProposalDto) => void;
  addTask: (proposal: PlannerAgentProposalDto, goalId: string) => void;
  dismiss: (proposal: PlannerAgentProposalDto) => void;
  /**
   * Asks the agent for goals (from the latest look back and the month and
   * quarter goals) or for tasks (for the goals chosen).
   */
  suggest?: (kind: "goals" | "tasks") => void;
  suggesting?: "goals" | "tasks" | null;
};

const normal = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * A proposed goal joins the plan: into its objective's empty slot when there
 * is one, else as a goal of its own, under the proposal's id so the tasks
 * proposed for it find it.
 */
export function plannerAddProposedGoal(
  forward: PlannerForwardState,
  proposal: Pick<PlannerAgentProposalDto, "id" | "pillar" | "title">,
): PlannerForwardState {
  const title = proposal.title.trim().slice(0, 1000);
  if (!title) return forward;
  const empty = forward.goals.find(
    (goal) => goal.pillar === proposal.pillar && !goal.title.trim(),
  );
  if (empty) {
    return {
      ...forward,
      edited: true,
      goals: forward.goals.map((goal) => {
        if (goal.id !== empty.id) return goal;
        const { fromSummary: _summary, ...rest } = goal;
        return { ...rest, title };
      }),
    };
  }
  if (forward.goals.length >= 12) return forward;
  return {
    ...forward,
    edited: true,
    goals: [
      ...forward.goals,
      { id: proposal.id, pillar: proposal.pillar, title, custom: true },
    ],
  };
}

/** The live card on the board with this title, To Do and Doing first. */
export function plannerFindBoardCard(
  board: Pick<PlannerBoardResponse, "columns">,
  title: string,
): { card: PlannerBoardCard; column: "todo" | "backlog" | "doing" } | null {
  const key = normal(title);
  for (const column of ["todo", "doing", "backlog"] as const) {
    const card = board.columns[column].find(
      (item) => normal(item.title) === key,
    );
    if (card) return { card, column };
  }
  return null;
}

/**
 * The plan's goal a proposed task goes under unless the owner picks another:
 * the goal it names, the goal made from the goal proposal it names, then one
 * of its objective, then the first.
 */
export function plannerProposalGoalId(
  proposal: Pick<PlannerAgentProposalDto, "goal_ref" | "pillar">,
  forward: Pick<PlannerForwardState, "goals">,
  proposals: readonly PlannerAgentProposalDto[],
): string | null {
  const named = plannerNamedGoals(forward);
  if (named.length === 0) return null;
  const ref = proposal.goal_ref;
  const direct = ref ? named.find((goal) => goal.id === ref) : undefined;
  if (direct) return direct.id;
  const parent = ref
    ? proposals.find((item) => item.id === ref && item.kind === "goal")
    : undefined;
  const byTitle = parent
    ? named.find((goal) => normal(goal.title) === normal(parent.title))
    : undefined;
  if (byTitle) return byTitle.id;
  const pillar = parent?.pillar ?? proposal.pillar;
  const byPillar = pillar
    ? named.find((goal) => goal.pillar === pillar)
    : undefined;
  return (byPillar ?? named[0])?.id ?? null;
}

/** Whether the agent is drafting this kind right now. */
function draftingOf(
  proposals: PlannerAgentProposalsResponse | undefined,
  kind: "goals" | "tasks",
): boolean {
  if (!proposals?.pending) return false;
  return (proposals.drafting ?? "goals") === kind;
}

/** "2026-10" for a month, "Q4 2026" for a quarter. */
function periodLabel(level: "month" | "quarter", start: string): string {
  if (level === "month") return start.slice(0, 7);
  const quarter = Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1;
  return `Q${quarter} ${start.slice(0, 4)}`;
}

function openOf(
  proposals: PlannerAgentProposalsResponse | undefined,
  kind: "goal" | "task",
) {
  return (proposals?.proposals ?? []).filter(
    (proposal) => proposal.kind === kind && proposal.state === "open",
  );
}

function Section({
  pending,
  strings,
  testId,
  action,
  top = false,
  children,
}: {
  pending: boolean;
  /** First on its step, under the title: no space above. */
  top?: boolean;
  strings: PlannerGoalsStrings;
  testId: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const text = strings.review.forward.proposals;
  return (
    <section
      aria-live="polite"
      className={cn("flex flex-col gap-2.5", !top && "mt-5")}
      data-testid={testId}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-xs font-medium tracking-[0.07em] text-muted-foreground uppercase">
          {text.title}
        </span>
        <PlannerBadge>{strings.review.forward.agent}</PlannerBadge>
        {pending && (
          <span className="planner-thinking text-[13px] text-muted-foreground">
            {text.drafting}
          </span>
        )}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

function Card({
  proposal,
  strings,
  children,
}: {
  proposal: PlannerAgentProposalDto;
  strings: PlannerGoalsStrings;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl border border-dashed border-border bg-card px-3.5 py-3",
        proposal.pillar && plannerPillarClass(proposal.pillar),
      )}
      data-testid="planner-proposal"
    >
      <div className="flex items-baseline gap-2">
        {proposal.pillar && (
          <PlannerPillarLabel
            className="shrink-0"
            pillar={proposal.pillar}
            short
            strings={strings}
          />
        )}
        <span className="min-w-0 leading-snug font-medium [overflow-wrap:anywhere]">
          {proposal.title}
        </span>
      </div>
      {proposal.serves && (
        <p
          className="text-[13px] leading-snug [overflow-wrap:anywhere]"
          data-testid="planner-proposal-serves"
        >
          <span className="text-muted-foreground">
            {strings.review.forward.proposals.serves(
              proposal.serves.level,
              periodLabel(proposal.serves.level, proposal.serves.period_start),
            )}
            {" · "}
          </span>
          {proposal.serves.title}
        </p>
      )}
      <p className="text-[13px] leading-snug text-muted-foreground">
        {proposal.why}
      </p>
      {proposal.quote && (
        <blockquote className="border-l-2 border-border pl-2.5 text-[13px] leading-snug text-muted-foreground">
          <span className="italic">“{proposal.quote}”</span>
          {proposal.source_day && (
            <span className="ml-1.5 font-mono text-xs">
              {proposal.source_day}
            </span>
          )}
        </blockquote>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}

/** Under Choose the week: the goals the agent proposes. */
export function PlannerGoalProposals({
  proposals,
  forward,
  strings,
  actions,
}: {
  proposals: PlannerAgentProposalsResponse | undefined;
  forward: PlannerForwardState;
  strings: PlannerGoalsStrings;
  actions: PlannerProposalActions;
}) {
  const open = openOf(proposals, "goal");
  const pending =
    draftingOf(proposals, "goals") || actions.suggesting === "goals";
  const canSuggest = Boolean(proposals?.agent && actions.suggest);
  if (open.length === 0 && !pending && !canSuggest) return null;
  const text = strings.review.forward.proposals;
  const asked = (proposals?.proposals ?? []).some(
    (proposal) => proposal.kind === "goal",
  );
  return (
    <Section
      action={
        canSuggest &&
        !pending && (
          <Button
            data-testid="planner-suggest-goals"
            disabled={Boolean(proposals?.pending)}
            size="sm"
            variant="outline"
            onClick={() => actions.suggest?.("goals")}
          >
            {asked ? text.suggestAgain : text.suggest}
          </Button>
        )
      }
      pending={pending}
      strings={strings}
      testId="planner-goal-proposals"
      top
    >
      {open.length === 0 && !pending && (
        <p className="text-[13px] text-muted-foreground">{text.suggestHint}</p>
      )}
      {open.map((proposal) => {
        const room =
          forward.goals.length < 12 ||
          forward.goals.some(
            (goal) => goal.pillar === proposal.pillar && !goal.title.trim(),
          );
        return (
          <Card key={proposal.id} proposal={proposal} strings={strings}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => actions.dismiss(proposal)}
            >
              {text.dismiss}
            </Button>
            <Button
              disabled={!room}
              size="sm"
              variant="outline"
              onClick={() => actions.addGoal(proposal)}
            >
              {text.add}
            </Button>
          </Card>
        );
      })}
    </Section>
  );
}

function TaskProposal({
  proposal,
  proposals,
  forward,
  board,
  strings,
  actions,
}: {
  proposal: PlannerAgentProposalDto;
  proposals: readonly PlannerAgentProposalDto[];
  forward: PlannerForwardState;
  board: PlannerBoardResponse | undefined;
  strings: PlannerGoalsStrings;
  actions: PlannerProposalActions;
}) {
  const text = strings.review.forward.proposals;
  const selectId = useId();
  const named = plannerNamedGoals(forward);
  const [picked, setPicked] = useState<string | null>(null);
  const goalId =
    picked && named.some((goal) => goal.id === picked)
      ? picked
      : plannerProposalGoalId(proposal, forward, proposals);
  const onBoard = board ? plannerFindBoardCard(board, proposal.title) : null;
  const full =
    board !== undefined &&
    plannerTodoCount(forward, board) >= plannerTodoCap &&
    onBoard?.column !== "todo" &&
    onBoard?.column !== "doing";
  return (
    <Card proposal={proposal} strings={strings}>
      {named.length === 0 ? (
        <span className="mr-auto text-xs text-muted-foreground">
          {text.needsGoal}
        </span>
      ) : (
        <>
          <label className="sr-only" htmlFor={selectId}>
            {text.goalLabel}
          </label>
          <select
            className="mr-auto h-8 max-w-[240px] min-w-0 truncate rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
            id={selectId}
            value={goalId ?? ""}
            onChange={(event) => setPicked(event.target.value)}
          >
            {named.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.title}
              </option>
            ))}
          </select>
        </>
      )}
      {full && <span className="text-xs text-warning">{text.full}</span>}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => actions.dismiss(proposal)}
      >
        {text.dismiss}
      </Button>
      <Button
        disabled={!goalId || full}
        size="sm"
        variant="outline"
        onClick={() => goalId && actions.addTask(proposal, goalId)}
      >
        {text.add}
      </Button>
    </Card>
  );
}

/** Under Plan tasks: the tasks the agent proposes, each for one of the plan's goals. */
export function PlannerTaskProposals({
  proposals,
  forward,
  board,
  strings,
  actions,
}: {
  proposals: PlannerAgentProposalsResponse | undefined;
  forward: PlannerForwardState;
  board: PlannerBoardResponse | undefined;
  strings: PlannerGoalsStrings;
  actions: PlannerProposalActions;
}) {
  const open = openOf(proposals, "task");
  const pending =
    draftingOf(proposals, "tasks") || actions.suggesting === "tasks";
  const canSuggest = Boolean(
    proposals?.agent &&
      actions.suggest &&
      plannerNamedGoals(forward).length > 0,
  );
  if (open.length === 0 && !pending && !canSuggest) return null;
  const text = strings.review.forward.proposals;
  const asked = (proposals?.proposals ?? []).some(
    (proposal) => proposal.kind === "task",
  );
  return (
    <Section
      action={
        canSuggest &&
        !pending && (
          <Button
            data-testid="planner-suggest-tasks"
            disabled={Boolean(proposals?.pending)}
            size="sm"
            variant="outline"
            onClick={() => actions.suggest?.("tasks")}
          >
            {asked ? text.suggestAgain : text.suggestTasks}
          </Button>
        )
      }
      pending={pending}
      strings={strings}
      testId="planner-task-proposals"
    >
      {open.length === 0 && !pending && (
        <p className="text-[13px] text-muted-foreground">
          {text.suggestTasksHint}
        </p>
      )}
      {open.map((proposal) => (
        <TaskProposal
          actions={actions}
          board={board}
          forward={forward}
          key={proposal.id}
          proposal={proposal}
          proposals={proposals?.proposals ?? []}
          strings={strings}
        />
      ))}
    </Section>
  );
}
