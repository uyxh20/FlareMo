import {
  type PlannerBoardCard,
  type PlannerTaskDetailResponse,
  type PlannerTaskProject,
  plannerIsValidDayKey,
  plannerQuarterLabel,
  type TaskPriority,
} from "@flaremo/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  BanIcon,
  CalendarDaysIcon,
  CalendarPlusIcon,
  CalendarRangeIcon,
  CheckIcon,
  CircleDotIcon,
  FlagIcon,
  FolderIcon,
  GaugeIcon,
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
import { listProjects } from "@/api";
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
import { plannerFetchTree } from "./api";
import {
  type PlannerColumnKey,
  plannerCardColumn,
  plannerColumns,
} from "./board-model";
import { plannerDayLong, plannerPlanLabel } from "./dates";
import { plannerFormatEffort, plannerParseEffort } from "./effort";
import {
  plannerCardFromDetail,
  plannerProjectPathLabel,
  plannerProjectPaths,
} from "./panel-model";
import { PlannerDayDialog, PlannerPlanMenuItems } from "./plan-picker";
import { plannerPlanForDay } from "./plan-targets";
import { plannerQueryKeys } from "./query-keys";
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

// --- Plan ---------------------------------------------------------------------

function PlanControl({
  card,
  today,
  actions,
}: {
  card: PlannerBoardCard;
  today: string;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const [pickingDay, setPickingDay] = useState(false);
  const column = plannerCardColumn(card);
  const label = plannerPlanLabel(card, today, strings);
  const value = label ? (
    <>
      {/* Sized here, not by the button: a finished or dropped task shows this
          outside a button, where an icon with no size would be 24px. */}
      <CalendarPlusIcon className="size-4 text-muted-foreground" />
      <span className="truncate" title={label.title}>
        {label.label}
      </span>
    </>
  ) : (
    <Empty />
  );

  // A finished task keeps its plan only as history, and a dropped one cannot be
  // planned until it is undropped: both show the plan without offering to change it.
  if (column === "done" || column === "dropped") {
    return (
      <span
        className="inline-flex h-8 min-w-0 items-center gap-1.5 px-2 text-sm text-muted-foreground"
        title={
          column === "done"
            ? strings.panel.planFinished
            : strings.panel.droppedHint
        }
      >
        <span className="sr-only">{strings.panel.property.plan}: </span>
        {value}
      </span>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={named(
                strings.panel.property.plan,
                label?.label ?? strings.panel.empty,
              )}
              className={VALUE_BUTTON}
              variant="ghost"
            >
              {value}
            </Button>
          }
        />
        <DropdownMenuContent className="min-w-44">
          <PlannerPlanMenuItems
            actions={actions}
            card={card}
            today={today}
            onPickDay={() => setPickingDay(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <PlannerDayDialog
        confirmLabel={strings.dayDialog.planConfirm}
        description={strings.dayDialog.planDescription}
        initial={today}
        min={today}
        open={pickingDay}
        title={strings.dayDialog.planTitle}
        onConfirm={(day) => actions.plan(card, plannerPlanForDay(day))}
        onOpenChange={setPickingDay}
      />
    </>
  );
}

// --- Due date -----------------------------------------------------------------

// A year typed into a date field passes through 0002, 0020 and 0202 on its way to
// 2026, and each of those is a valid date to the browser. Only a plausible year is
// saved, so typing the year does not save three wrong due dates on the way.
const EARLIEST_DUE_YEAR = 1900;

/** Whether a date field's value is a complete day worth saving. */
function isSavableDay(value: string): boolean {
  return (
    plannerIsValidDayKey(value) &&
    Number(value.slice(0, 4)) >= EARLIEST_DUE_YEAR
  );
}

function DueControl({
  card,
  actions,
}: {
  card: PlannerBoardCard;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.due_at ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Follow the saved date whenever the field is not being typed into.
  useEffect(() => {
    if (!editing) setDraft(card.due_at ?? "");
  }, [card.due_at, editing]);

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
            strings.panel.property.due,
            card.due_at
              ? plannerDayLong(card.due_at, strings.intlLocale)
              : strings.panel.empty,
          )}
          className={VALUE_BUTTON}
          variant="ghost"
          onClick={() => setEditing(true)}
        >
          {card.due_at ? (
            <>
              <CalendarDaysIcon className="text-muted-foreground" />
              <span className="truncate">
                {plannerDayLong(card.due_at, strings.intlLocale)}
              </span>
            </>
          ) : (
            <Empty />
          )}
        </Button>
        {card.due_at && (
          <Button
            aria-label={strings.menu.clearDue}
            size="icon-sm"
            title={strings.menu.clearDue}
            variant="ghost"
            onClick={() => actions.setDue(card, null)}
          >
            <XIcon />
          </Button>
        )}
      </>
    );
  }

  return (
    <Input
      aria-label={strings.panel.property.due}
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
          if (value !== card.due_at) actions.setDue(card, value);
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

function GoalControl({
  card,
  current,
  actions,
}: {
  card: PlannerBoardCard;
  /** The task's project from the detail, with the path above it. */
  current: PlannerTaskProject | null;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  // The same list and cache key as upstream's task dialog, so the two share it.
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects(),
  });
  // The paths are a nicety: without the tree the goals still list by name.
  const treeQuery = useQuery({
    queryKey: plannerQueryKeys.tree,
    queryFn: plannerFetchTree,
    staleTime: 30_000,
  });

  const options = useMemo(() => {
    const paths = plannerProjectPaths(treeQuery.data?.nodes ?? []);
    const all = projectsQuery.data?.projects ?? [];
    // Active projects to pick from; a task that still points at an archived one
    // keeps it in the list, so its value never disappears (as upstream's dialog does).
    const live = all.filter(
      (project) => project.status === "active" && !project.deleted_at,
    );
    const shown =
      current && !live.some((project) => project.id === current.id)
        ? [...live, ...all.filter((project) => project.id === current.id)]
        : live;
    return shown
      .map(
        (project): PlannerTaskProject =>
          paths.get(project.id) ?? {
            id: project.id,
            name: project.name,
            ancestors: [],
          },
      )
      .map((project) => ({
        project,
        label: plannerProjectPathLabel(project),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [projectsQuery.data, treeQuery.data, current]);

  const currentLabel = current ? plannerProjectPathLabel(current) : null;

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
            variant="ghost"
          >
            {currentLabel ? (
              <>
                <FolderIcon className="text-muted-foreground" />
                <span className="truncate" title={currentLabel}>
                  {currentLabel}
                </span>
              </>
            ) : (
              <Empty />
            )}
          </Button>
        }
      />
      <DropdownMenuContent className="max-h-72 min-w-56">
        <DropdownMenuItem
          disabled={card.project_id === null}
          onClick={() => actions.setProject(card, null)}
        >
          {strings.panel.none}
          {card.project_id === null && <CheckIcon className="ml-auto" />}
        </DropdownMenuItem>
        {options.length > 0 && <DropdownMenuSeparator />}
        {options.map(({ project, label }) => (
          <DropdownMenuItem
            key={project.id}
            onClick={() => {
              if (project.id !== card.project_id) {
                actions.setProject(card, project);
              }
            }}
          >
            <span className="truncate" title={label}>
              {label}
            </span>
            {project.id === card.project_id && (
              <CheckIcon className="ml-auto shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
        {options.length === 0 && !projectsQuery.isPending && (
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
  today,
  actions,
}: {
  detail: PlannerTaskDetailResponse;
  today: string;
  actions: PlannerActions;
}) {
  const strings = usePlannerStrings();
  const card = useMemo(() => plannerCardFromDetail(detail), [detail]);
  const quarter = plannerQuarterLabel({
    planPeriodStart: detail.plan?.period_start,
    dueAt: detail.task.due_at,
  });

  return (
    <div className="flex flex-col" data-testid="planner-properties">
      <PropertyRow
        icon={<CircleDotIcon />}
        label={strings.panel.property.status}
      >
        <StatusControl actions={actions} card={card} />
      </PropertyRow>
      <PropertyRow
        icon={<CalendarPlusIcon />}
        label={strings.panel.property.plan}
      >
        <PlanControl actions={actions} card={card} today={today} />
      </PropertyRow>
      <PropertyRow
        icon={<CalendarDaysIcon />}
        label={strings.panel.property.due}
      >
        <DueControl actions={actions} card={card} />
      </PropertyRow>
      <PropertyRow icon={<FlagIcon />} label={strings.panel.property.priority}>
        <PriorityControl actions={actions} card={card} />
      </PropertyRow>
      <PropertyRow icon={<TargetIcon />} label={strings.panel.property.goal}>
        <GoalControl actions={actions} card={card} current={detail.project} />
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
    </div>
  );
}
