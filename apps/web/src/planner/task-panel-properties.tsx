import {
  type PlannerBoardCard,
  type PlannerGoalDto,
  type PlannerTaskDetailResponse,
  plannerIsValidDayKey,
  plannerQuarterLabel,
  type TaskPriority,
} from "@flaremo/contracts";
import {
  BanIcon,
  CalendarDaysIcon,
  CalendarPlusIcon,
  CalendarRangeIcon,
  CheckIcon,
  CircleDotIcon,
  FlagIcon,
  GaugeIcon,
  PlayIcon,
  TargetIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PRIORITY_BADGE } from "@/pages/projects/constants";
import {
  type PlannerColumnKey,
  plannerCardColumn,
  plannerColumns,
} from "./board-model";
import { plannerDayLong, plannerLocalDayOf } from "./dates";
import { plannerFormatEffort, plannerParseEffort } from "./effort";
import { plannerPillarClass } from "./goal-cards";
import {
  type PlannerGoalsStrings,
  usePlannerGoalsStrings,
} from "./goals-strings";
import { plannerCardFromDetail } from "./panel-model";
import { usePlannerStrings } from "./strings";
import { PlannerColumnIcon } from "./task-card";
import type { PlannerActions } from "./use-planner-actions";

// The task panel's properties (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13), laid out like a
// Notion page: an icon, a muted label and a value you click, in a row. A property
// with no value says "Empty", as Notion does. Status, Plan, Due date and Priority
// are the card's own fields and use the cockpit's actions (so the board behind
// the panel moves with them); Goal and Effort are new; Quarter is worked out from
// the plan or the due date and cannot be edited.
//
// Every control saves the moment it is used, except the two that are typed into,
// the due date and the effort, which save when the person is done typing.

/** The one place the panel's value buttons get their look: a quiet button, left aligned. */
const VALUE_BUTTON =
  "h-8 max-w-full min-w-0 justify-start gap-1.5 px-2 font-normal";

function Empty() {
  const strings = usePlannerStrings();
  return <span className="text-muted-foreground">{strings.panel.empty}</span>;
}

/** An icon, a muted label and the value control. */
function PropertyRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-9 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-2 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span aria-hidden="true" className="flex shrink-0 [&>svg]:size-3.5">
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1">
        {children}
      </div>
    </div>
  );
}

/**
 * A control's name for a screen reader: the row's label and the value, "Status: To
 * Do". Sighted people read the label beside the value; this puts the two together
 * for everyone else. The visible text is part of it, as WCAG asks.
 */
const named = (label: string, value: string) => `${label}: ${value}`;

// --- Status -------------------------------------------------------------------

/** A pill per column, tinted like the Notion board's: the text stays the foreground colour. */
const STATUS_PILL: Record<PlannerColumnKey, string> = {
  backlog: "bg-muted text-foreground",
  todo: "bg-info/15 text-foreground",
  doing: "bg-brand-100 text-brand-700 dark:bg-brand-400/15 dark:text-brand-200",
  done: "bg-success/15 text-foreground",
  other: "bg-muted text-foreground",
  dropped: "bg-muted text-muted-foreground",
};

function StatusControl({
  card,
  actions,
}: {
  card: PlannerBoardCard;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const column = plannerCardColumn(card);
  const dropped = column === "dropped";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={named(
              strings.panel.property.status,
              strings.column[column],
            )}
            className="h-8 max-w-full min-w-0 justify-start px-1 font-normal"
            variant="ghost"
          >
            <span
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
                STATUS_PILL[column],
              )}
            >
              {dropped ? (
                <BanIcon className="size-3.5" />
              ) : (
                <PlannerColumnIcon column={column} />
              )}
              {strings.column[column]}
            </span>
          </Button>
        }
      />
      <DropdownMenuContent className="min-w-44">
        {dropped ? (
          <DropdownMenuItem onClick={() => actions.undrop(card)}>
            <Undo2Icon />
            {strings.menu.undrop}
          </DropdownMenuItem>
        ) : (
          plannerColumns.map((target) => (
            <DropdownMenuItem
              key={target}
              onClick={() => {
                if (target !== column) actions.move(card, target);
              }}
            >
              <PlannerColumnIcon column={target} />
              {strings.column[target]}
              {target === column && <CheckIcon className="ml-auto" />}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Start and due dates ------------------------------------------------------

// A year typed into a date field passes through 0002, 0020 and 0202 on its way to
// 2026, and each of those is a valid date to the browser. Only a plausible year is
// saved, so typing the year does not save three wrong dates on the way.
const EARLIEST_DUE_YEAR = 1900;

/** Whether a date field's value is a complete day worth saving. */
function isSavableDay(value: string): boolean {
  return (
    plannerIsValidDayKey(value) &&
    Number(value.slice(0, 4)) >= EARLIEST_DUE_YEAR
  );
}

/**
 * A day property, the start date or the due date: shows the saved day, and opens a
 * date field when clicked. A complete day saves at once; an empty or cleared one
 * is sent as null by the clear button.
 */
function DateControl({
  current,
  label,
  clearLabel,
  onSave,
}: {
  /** The saved day, or null. */
  current: string | null;
  /** The property's name, for the field and the value button. */
  label: string;
  clearLabel: string;
  onSave: (day: string | null) => void;
}) {
  const strings = usePlannerStrings();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Follow the saved date whenever the field is not being typed into.
  useEffect(() => {
    if (!editing) setDraft(current ?? "");
  }, [current, editing]);

  // The picker opens as the field appears: one click from "Empty" to a calendar.
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    input?.focus();
    try {
      input?.showPicker?.();
    } catch {
      // No picker, or no user activation: the focused field is still usable.
    }
  }, [editing]);

  if (!editing) {
    return (
      <>
        <Button
          aria-label={named(
            label,
            current
              ? plannerDayLong(current, strings.intlLocale)
              : strings.panel.empty,
          )}
          className={VALUE_BUTTON}
          variant="ghost"
          onClick={() => setEditing(true)}
        >
          {current ? (
            <>
              <CalendarDaysIcon className="text-muted-foreground" />
              <span className="truncate">
                {plannerDayLong(current, strings.intlLocale)}
              </span>
            </>
          ) : (
            <Empty />
          )}
        </Button>
        {current && (
          <Button
            aria-label={clearLabel}
            size="icon-sm"
            title={clearLabel}
            variant="ghost"
            onClick={() => onSave(null)}
          >
            <XIcon />
          </Button>
        )}
      </>
    );
  }

  return (
    <Input
      aria-label={label}
      className="h-8 w-44 border-input"
      ref={inputRef}
      type="date"
      value={draft}
      onBlur={() => setEditing(false)}
      onChange={(event) => {
        const value = event.target.value;
        setDraft(value);
        if (isSavableDay(value)) {
          setEditing(false);
          if (value !== current) onSave(value);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Close the field, not the panel behind it.
          event.stopPropagation();
          setEditing(false);
        }
      }}
    />
  );
}

// --- Priority -----------------------------------------------------------------

const PRIORITIES: readonly TaskPriority[] = ["none", "low", "medium", "high"];

function PriorityControl({
  card,
  actions,
}: {
  card: PlannerBoardCard;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const current = (PRIORITIES as readonly string[]).includes(card.priority)
    ? (card.priority as TaskPriority)
    : "none";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={named(
              strings.panel.property.priority,
              current === "none"
                ? strings.panel.empty
                : strings.priority[current],
            )}
            className={VALUE_BUTTON}
            variant="ghost"
          >
            {current === "none" ? (
              <Empty />
            ) : (
              <Badge variant={PRIORITY_BADGE[current]}>
                <FlagIcon data-icon="inline-start" />
                {strings.priority[current]}
              </Badge>
            )}
          </Button>
        }
      />
      <DropdownMenuContent className="min-w-40">
        {PRIORITIES.map((priority) => (
          <DropdownMenuItem
            key={priority}
            onClick={() => {
              if (priority !== current) actions.setPriority(card, priority);
            }}
          >
            {priority === "none" ? (
              strings.panel.none
            ) : (
              <Badge variant={PRIORITY_BADGE[priority]}>
                <FlagIcon data-icon="inline-start" />
                {strings.priority[priority]}
              </Badge>
            )}
            {priority === current && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Goal ---------------------------------------------------------------------

/** "Work · Ship the launch": the goal's objective, then its title. */
function goalLabel(goal: PlannerGoalDto, strings: PlannerGoalsStrings): string {
  const pillar = goal.pillar ? strings.pillar[goal.pillar] : strings.noPillar;
  const title = goal.title.trim() || goal.lines[0]?.text.trim() || "";
  return title ? `${pillar} · ${title}` : pillar;
}

// The goal a task serves is one of the cockpit week's goals, the ones the board
// tints its cards with and the weekly review plans. Projects are not offered any
// more (the owner's decision, 13 Oct 2026); a task keeps its project link in the
// database, untouched.
function GoalControl({
  card,
  weekGoals,
  actions,
}: {
  card: PlannerBoardCard;
  weekGoals: readonly PlannerGoalDto[];
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const goalStrings = usePlannerGoalsStrings();
  const options = useMemo(
    () =>
      [...weekGoals]
        .filter((goal) => goal.status !== "closed")
        .sort((left, right) => left.sort_order - right.sort_order),
    [weekGoals],
  );
  const current =
    card.goal_id === null
      ? null
      : (weekGoals.find((goal) => goal.id === card.goal_id) ?? null);
  // A goal of another week (or a removed one) is still the task's goal: it shows
  // as such until another is picked.
  const currentLabel =
    card.goal_id === null
      ? null
      : current
        ? goalLabel(current, goalStrings)
        : strings.panel.otherWeekGoal;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={named(
              strings.panel.property.goal,
              currentLabel ?? strings.panel.empty,
            )}
            className={VALUE_BUTTON}
            data-testid="planner-panel-goal"
            variant="ghost"
          >
            {currentLabel ? (
              <span
                className={cn(
                  "inline-flex min-w-0 items-center gap-1.5",
                  current && plannerPillarClass(current.pillar),
                )}
              >
                {current && <i aria-hidden="true" className="planner-dot" />}
                <span className="truncate" title={currentLabel}>
                  {currentLabel}
                </span>
              </span>
            ) : (
              <Empty />
            )}
          </Button>
        }
      />
      <DropdownMenuContent className="max-h-72 min-w-56">
        <DropdownMenuItem
          disabled={card.goal_id === null}
          onClick={() => actions.setGoal(card, null)}
        >
          {strings.panel.none}
          {card.goal_id === null && <CheckIcon className="ml-auto" />}
        </DropdownMenuItem>
        {options.length > 0 && <DropdownMenuSeparator />}
        {options.map((goal) => {
          const label = goalLabel(goal, goalStrings);
          return (
            <DropdownMenuItem
              className={plannerPillarClass(goal.pillar)}
              key={goal.id}
              onClick={() => {
                if (goal.id !== card.goal_id) actions.setGoal(card, goal.id);
              }}
            >
              <i aria-hidden="true" className="planner-dot shrink-0" />
              <span className="truncate" title={label}>
                {label}
              </span>
              {goal.id === card.goal_id && (
                <CheckIcon className="ml-auto shrink-0" />
              )}
            </DropdownMenuItem>
          );
        })}
        {options.length === 0 && (
          <DropdownMenuItem disabled>{strings.panel.noGoals}</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Effort -------------------------------------------------------------------

function EffortControl({
  card,
  effort,
  actions,
}: {
  card: PlannerBoardCard;
  effort: number | null;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const [text, setText] = useState(plannerFormatEffort(effort));
  const [focused, setFocused] = useState(false);
  // Set by Escape for the length of the blur it causes: that blur runs `commit`
  // with the text as last rendered, which would save what Escape is throwing away.
  const reverting = useRef(false);
  const errorId = useId();

  // Follow the saved estimate whenever the field is not being typed into.
  useEffect(() => {
    if (!focused) setText(plannerFormatEffort(effort));
  }, [effort, focused]);

  const parsed = plannerParseEffort(text);
  const invalid = !parsed.ok;

  const commit = () => {
    setFocused(false);
    if (reverting.current || !parsed.ok) {
      // Nothing to save, or Escape: put the saved estimate back.
      setText(plannerFormatEffort(effort));
      return;
    }
    if (parsed.value !== effort) actions.setEffort(card, parsed.value);
  };

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Input
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid || undefined}
        aria-label={strings.panel.property.effort}
        autoComplete="off"
        className="h-8 w-28 border-transparent bg-transparent px-2 hover:bg-muted focus-visible:bg-transparent dark:bg-transparent dark:hover:bg-muted/50"
        inputMode="decimal"
        placeholder={strings.panel.empty}
        value={text}
        onBlur={commit}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => setFocused(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            // Put the saved estimate back and leave, without closing the panel.
            event.stopPropagation();
            reverting.current = true;
            event.currentTarget.blur();
            reverting.current = false;
          }
        }}
      />
      {invalid && (
        <p className="px-2 text-xs text-destructive" id={errorId} role="alert">
          {strings.panel.effortInvalid}
        </p>
      )}
    </div>
  );
}

// --- The list -----------------------------------------------------------------

export function PlannerTaskProperties({
  detail,
  actions,
  weekGoals = [],
}: {
  detail: PlannerTaskDetailResponse;
  actions: PlannerActions;
  /** The cockpit week's goals, which the Goal property picks from. */
  weekGoals?: readonly PlannerGoalDto[];
}) {
  const strings = usePlannerStrings();
  const card = useMemo(() => plannerCardFromDetail(detail), [detail]);
  const quarter = plannerQuarterLabel({
    startDate: card.start_date,
    dueAt: card.due_at,
  });

  return (
    <div className="flex flex-col" data-testid="planner-properties">
      <PropertyRow
        icon={<CircleDotIcon />}
        label={strings.panel.property.status}
      >
        <StatusControl actions={actions} card={card} />
      </PropertyRow>
      <PropertyRow icon={<PlayIcon />} label={strings.panel.property.start}>
        <DateControl
          clearLabel={strings.panel.clearStart}
          current={card.start_date}
          label={strings.panel.property.start}
          onSave={(day) => actions.setStartDate(card, day)}
        />
      </PropertyRow>
      <PropertyRow
        icon={<CalendarDaysIcon />}
        label={strings.panel.property.due}
      >
        <DateControl
          clearLabel={strings.menu.clearDue}
          current={card.due_at}
          label={strings.panel.property.due}
          onSave={(day) => actions.setDue(card, day)}
        />
      </PropertyRow>
      <PropertyRow icon={<FlagIcon />} label={strings.panel.property.priority}>
        <PriorityControl actions={actions} card={card} />
      </PropertyRow>
      <PropertyRow icon={<TargetIcon />} label={strings.panel.property.goal}>
        <GoalControl actions={actions} card={card} weekGoals={weekGoals} />
      </PropertyRow>
      <PropertyRow icon={<GaugeIcon />} label={strings.panel.property.effort}>
        <EffortControl
          actions={actions}
          card={card}
          effort={detail.plan?.effort ?? null}
        />
      </PropertyRow>
      <PropertyRow
        icon={<CalendarRangeIcon />}
        label={strings.panel.property.quarter}
      >
        <span className="inline-flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 px-2 text-sm">
          {quarter ?? <Empty />}
          <span className="text-xs text-muted-foreground">
            {strings.panel.quarterHint}
          </span>
        </span>
      </PropertyRow>
      {/* Read-only, like the quarter: when the task was made. */}
      <PropertyRow
        icon={<CalendarPlusIcon />}
        label={strings.panel.property.created}
      >
        <span className="inline-flex min-h-8 min-w-0 items-center px-2 text-sm">
          {plannerDayLong(
            plannerLocalDayOf(detail.task.created_at),
            strings.intlLocale,
          )}
        </span>
      </PropertyRow>
    </div>
  );
}
