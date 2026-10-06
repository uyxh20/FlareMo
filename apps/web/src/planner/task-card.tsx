import type { PlannerBoardCard, PlannerColumn } from "@flaremo/contracts";
import {
  ArrowRightLeftIcon,
  BanIcon,
  CalendarDaysIcon,
  CalendarXIcon,
  CheckIcon,
  CircleDashedIcon,
  FlagIcon,
  FolderIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Undo2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  ADVANCE_KEY,
  ADVANCE_TARGET,
  MORE_BUTTON_CLASS,
  PRIORITY_BADGE,
} from "@/pages/projects/constants";
import { StatusIcon } from "@/pages/projects/task-card";
import {
  type PlannerColumnKey,
  plannerCardColumn,
  plannerColumns,
  plannerIsOverdue,
  plannerIsPendingCard,
} from "./board-model";
import {
  plannerDayLong,
  plannerDueLabel,
  plannerPlanLabel,
  plannerRelativeTime,
} from "./dates";
import { PlannerPlanSubmenu } from "./plan-picker";
import { usePlannerStrings } from "./strings";
import type { PlannerActions } from "./use-planner-actions";

// A task on the cockpit board (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5).
//
// Upstream's TaskCard cannot carry the cockpit's extras (the plan chip, the
// carried badge, the plan menu, history, drop), and the fork must not edit it, so
// this card is built from the same exported pieces: the status icon, the
// priority badge variants, the advance keys and the menu button styling.
//
// Clicking a card opens its task panel (section 13), and so does Enter or Space on
// its title, which is a real button for exactly that: a keyboard reaches the card
// through it, and a screen reader hears the task's name. The whole card is the
// click target, as in Notion, except for what has a job of its own: the status
// icon, the menu, any button or link. A drag does not open it: the board's mouse
// sensor starts a drag only after the pointer moves 6px and its touch sensor only
// after a long press, and dnd-kit swallows the click that ends a drag, so only a
// click that was one gets here (board.test.tsx pins this against the real library).

// What has a job of its own inside a card. A click that starts in one of these,
// or in a menu opened from the card, is that control's and does not open the card.
const OWN_CLICK =
  "button, a[href], input, select, textarea, label, summary, [role='button'], [role='menuitem'], [role='menu'], [role='dialog']";

/**
 * Whether a click on a card should open it. Not when it started inside a control
 * that does something else, and not when it did not start inside the card at all:
 * a menu's items are React children of the card but DOM children of the page, so
 * their clicks bubble up through React to the card's handler with a target
 * outside the card.
 */
export function plannerClickOpensCard(event: {
  currentTarget: Element;
  target: EventTarget | null;
}): boolean {
  const { currentTarget, target } = event;
  if (!(target instanceof Element)) return false;
  if (!currentTarget.contains(target)) return false;
  const control = target.closest(OWN_CLICK);
  return (
    control === null ||
    control === currentTarget ||
    !currentTarget.contains(control)
  );
}

/** What a card asks the page to open: each of these needs a dialog or a sheet. */
export type PlannerCardRequest = {
  kind: "edit" | "history" | "drop" | "pickDay" | "setDue";
  card: PlannerBoardCard;
};

/** The icon at the head of a column and in the Move to menu. */
export function PlannerColumnIcon({ column }: { column: PlannerColumnKey }) {
  switch (column) {
    case "todo":
      return <StatusIcon status="todo" />;
    case "doing":
      return <StatusIcon status="in_progress" />;
    case "done":
      return <StatusIcon status="done" />;
    default:
      return <CircleDashedIcon className="size-4 text-muted-foreground" />;
  }
}

/** Upstream's advance step (todo, in progress, done, back to todo) as a column. */
const ADVANCE_COLUMN = {
  todo: "todo",
  in_progress: "doing",
  done: "done",
} as const satisfies Record<"todo" | "in_progress" | "done", PlannerColumn>;

function knownStatus(status: string): "todo" | "in_progress" | "done" {
  return status === "in_progress" || status === "done" ? status : "todo";
}

function Chip({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground",
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}

export function PlannerTaskCard({
  card,
  today,
  actions,
  onRequest,
  onOpen,
  overlay = false,
  className,
}: {
  card: PlannerBoardCard;
  today: string;
  actions: PlannerActions;
  onRequest: (request: PlannerCardRequest) => void;
  /** Opens the card's task panel: a click on the card, Enter or Space on its title. */
  onOpen: (card: PlannerBoardCard) => void;
  /** A static copy under the pointer while dragging: no menu, nothing to click. */
  overlay?: boolean;
  className?: string;
}) {
  const strings = usePlannerStrings();
  const { t } = useI18n();
  const locale = strings.intlLocale;
  const column = plannerCardColumn(card);
  const isDropped = column === "dropped";
  const isDone = column === "done";
  const status = knownStatus(card.status);
  // A card the server has not answered for yet has nothing to open or act on.
  const waiting = plannerIsPendingCard(card);
  const inert = overlay || waiting;

  // A finished or dropped task's plan is history, not information.
  const plan =
    isDone || isDropped ? null : plannerPlanLabel(card, today, strings);
  const overdue = plannerIsOverdue(card, today);
  const advanceLabel = t(ADVANCE_KEY[status]);
  const hasChips =
    plan !== null ||
    card.carry_count > 0 ||
    card.priority !== "none" ||
    card.due_at !== null ||
    card.project_name !== null ||
    isDropped;

  const request = (kind: PlannerCardRequest["kind"]) =>
    onRequest({ kind, card });

  const statusIcon = <StatusIcon status={status} />;

  return (
    <Card
      aria-busy={waiting || undefined}
      className={cn(
        "group gap-0 py-2.5 shadow-xs",
        !inert &&
          "cursor-pointer motion-safe:transition-shadow motion-safe:duration-150 hover:shadow-sm hover:ring-foreground/20",
        waiting && "opacity-70",
        overlay && "shadow-lg ring-brand-400/40",
        isDropped && "bg-card/60",
        className,
      )}
      onClick={
        inert
          ? undefined
          : (event) => {
              if (plannerClickOpensCard(event)) onOpen(card);
            }
      }
    >
      <CardContent className="flex flex-col gap-1.5 px-3">
        <div className="flex items-start gap-2">
          {isDropped || inert ? (
            <span className="mt-0.5 shrink-0 p-0.5 opacity-60">
              {statusIcon}
            </span>
          ) : (
            <button
              aria-label={advanceLabel}
              className="mt-px -ml-0.5 shrink-0 cursor-pointer rounded-md p-0.5 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 hover:text-foreground"
              title={advanceLabel}
              type="button"
              onClick={() =>
                actions.move(card, ADVANCE_COLUMN[ADVANCE_TARGET[status]])
              }
            >
              {statusIcon}
            </button>
          )}
          {inert ? (
            <span
              className={cn(
                "min-w-0 flex-1 text-sm leading-snug break-words",
                (isDone || isDropped) && "text-muted-foreground",
                isDone && "line-through",
              )}
            >
              {card.title}
            </span>
          ) : (
            <button
              aria-haspopup="dialog"
              className={cn(
                "min-w-0 flex-1 cursor-pointer rounded-sm text-left text-sm leading-snug break-words outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                (isDone || isDropped) && "text-muted-foreground",
                isDone && "line-through",
              )}
              type="button"
              onClick={() => onOpen(card)}
            >
              {card.title}
            </button>
          )}
          {!inert && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={strings.card.actions}
                    className={cn(MORE_BUTTON_CLASS, "-mt-1 -mr-1.5")}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <MoreHorizontalIcon />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-52">
                {isDropped ? (
                  <DropdownMenuItem onClick={() => actions.undrop(card)}>
                    <Undo2Icon />
                    {strings.menu.undrop}
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <ArrowRightLeftIcon />
                        {strings.menu.moveTo}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-44">
                        {plannerColumns.map((target) => (
                          <DropdownMenuItem
                            key={target}
                            onClick={() => {
                              if (target !== column) actions.move(card, target);
                            }}
                          >
                            <PlannerColumnIcon column={target} />
                            {strings.column[target]}
                            {target === column && (
                              <CheckIcon className="ml-auto" />
                            )}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    {!isDone && (
                      <PlannerPlanSubmenu
                        actions={actions}
                        card={card}
                        today={today}
                        onPickDay={() => request("pickDay")}
                      />
                    )}
                    <DropdownMenuItem onClick={() => request("setDue")}>
                      <CalendarDaysIcon />
                      {card.due_at
                        ? strings.menu.changeDue
                        : strings.menu.setDue}
                    </DropdownMenuItem>
                    {card.due_at && (
                      <DropdownMenuItem
                        onClick={() => actions.setDue(card, null)}
                      >
                        <CalendarXIcon />
                        {strings.menu.clearDue}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => request("edit")}>
                  <PencilIcon />
                  {strings.menu.edit}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => request("history")}>
                  <HistoryIcon />
                  {strings.menu.history}
                </DropdownMenuItem>
                {!isDropped && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => request("drop")}
                    >
                      <BanIcon />
                      {strings.menu.drop}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasChips && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6">
            {plan && (
              <Badge title={plan.title} variant="secondary">
                {plan.label}
              </Badge>
            )}
            {card.carry_count > 0 && (
              <Badge
                title={strings.card.carriedTitle(card.carry_count)}
                variant="outline"
              >
                {strings.card.carried(card.carry_count)}
              </Badge>
            )}
            {card.priority !== "none" && (
              <Badge
                variant={
                  PRIORITY_BADGE[
                    card.priority as keyof typeof PRIORITY_BADGE
                  ] ?? "secondary"
                }
              >
                <FlagIcon data-icon="inline-start" />
                {strings.priority[
                  card.priority as keyof typeof strings.priority
                ] ?? card.priority}
              </Badge>
            )}
            {card.due_at && (
              <Chip
                className={cn(overdue && "text-destructive")}
                title={`${strings.card.due(plannerDayLong(card.due_at, locale))}${
                  overdue ? ` · ${strings.card.overdue}` : ""
                }`}
              >
                <CalendarDaysIcon className="size-3 shrink-0" />
                {plannerDueLabel(card.due_at, today, strings)}
              </Chip>
            )}
            {card.project_name && (
              <Chip title={card.project_name}>
                <FolderIcon className="size-3 shrink-0" />
                <span className="truncate">{card.project_name}</span>
              </Chip>
            )}
            {isDropped && card.dropped_at && (
              <Chip>
                {strings.card.dropped(
                  plannerRelativeTime(card.dropped_at, Date.now(), locale),
                )}
              </Chip>
            )}
          </div>
        )}
        {isDropped && !inert && (
          <div className="pl-6">
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => actions.undrop(card)}
            >
              <Undo2Icon data-icon="inline-start" />
              {strings.menu.undrop}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
