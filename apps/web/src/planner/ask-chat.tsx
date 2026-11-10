import type {
  PlannerAgentActionDto,
  PlannerAskResponse,
} from "@flaremo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  CheckIcon,
  Loader2Icon,
  PaperclipIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { plannerFetchTaskDetail } from "./api";
import {
  plannerAskRequest,
  plannerFetchAsk,
  plannerRevertActionRequest,
  plannerSettleActionRequest,
} from "./ask-api";
import {
  type PlannerCardEditing,
  PlannerCardField,
  usePlannerCardEdits,
  usePlannerGoalChoices,
} from "./ask-card-edit";
import {
  plannerCardEditableKeys,
  plannerCardEditBody,
} from "./ask-card-edit-model";
import { plannerDueLabel } from "./dates";
import { plannerQueryKeys } from "./query-keys";
import { PlannerMarkdown } from "./review-markdown";
import { usePlannerStrings } from "./strings";
import {
  plannerAttachmentState,
  usePlannerAttachmentActions,
} from "./use-attachment-actions";
import { usePlannerChatFiles } from "./use-chat-files";
import { usePlannerToday } from "./use-planner-clock";
import "./goals.css";

// The agent chat itself (fork-owned add-on, docs/fork-general-agent.md): the
// messages, the agent's proposal cards and the question box. Ask my diary's
// window (ask-window.tsx) and a task's own agent drawer (task-agent.tsx) are
// two frames around this one component; the task's chat is held from its task
// (`task`), so the agent reads that task first and proposes into it.
//
// A proposal is a card with Accept and Dismiss. The accept is the write: the
// server makes the change as the proposal, and the task, the board and the
// History are read again. Nothing is written before the owner accepts.
//
// A task's chat also takes files (docs/fork-task-attachments.md, phase 3): a
// drop on the chat or a paste into the question box is the same upload as the
// panel's Attachments, so "here is the email, what should I do" is one motion.
// The files dropped here are listed above the question box with their state;
// the agent reads their text through read_task once they are read.
//
// Ask my diary takes files as well, by drop, paste or the paperclip: each is
// read at once into text (use-chat-files.ts), shown as a chip above the
// question box, and sent with the next question; the file itself is not kept.

const en = {
  title: "Ask my diary",
  taskTitle: "Agent",
  openTask: "Ask agent",
  newChat: "New chat",
  close: "Close",
  empty:
    "Ask about your diary, goals, tasks or health. The agent reads everything and writes only what you accept.",
  emptyTask:
    "Ask for notes, a title, a due date or a plan for this task. The agent proposes; you accept or dismiss.",
  reading: "Reading your diary",
  noAnswer: "No answer came. Ask again.",
  placeholder: "Ask a question",
  placeholderTask: "Ask for a draft, or a change",
  send: "Send",
  /** The task's chat takes files too: the same upload as the panel's Attachments. */
  dropFile: "Drop a file here to put it on the task",
  filesOnTask: "Put on the task",
  /** Ask my diary takes files too: read into the next question, not kept. */
  attach: "Attach a file",
  dropFileChat: "Drop a file to read it into your question",
  filesForQuestion: "Goes with your question",
  fileReading: "reading…",
  fileReady: "read",
  fileUnreadable: "couldn't read it",
  removeFile: "Remove file",
  fileTooLarge: (name: string, max: string) => `${name} is over ${max}`,
  fileTooMany: (max: number) => `At most ${max} files a question`,
  fileOnly: "Here is a file. What should I take from it?",
  failed: "Couldn't ask. Try again.",
  days: (from: string, to: string) => `Diary ${from} to ${to}`,
  proposal: {
    change: (field: string) => `Proposed ${field}`,
    newTask: "Proposed task",
    entry: "Proposed diary entry",
    comment: "Proposed comment",
    accept: "Accept",
    dismiss: "Dismiss",
    accepted: "Accepted",
    dismissed: "Dismissed",
    expired: "Expired",
    reverted: "Undone",
    failed: "Couldn't apply. Try again.",
    field: {
      title: "title",
      notes: "notes",
      priority: "priority",
      due_at: "due date",
      effort: "effort",
      start_date: "start date",
      column: "column",
      goal_id: "goal",
      dropped: "drop",
      place: "place",
    },
    placeHeading: "Move on the board",
    placeLine: (column: string, below: boolean, anchor: string) =>
      `To ${column}, ${below ? "below" : "above"} ${anchor}`,
    link: "Link entries",
    unlink: "Unlink entries",
    memoryCorrect: "Correct memory",
    memoryForget: "Forget memory",
    healthFix: "Fix health row",
    healthAdd: "Add health row",
    healthRemove: "Remove health row",
    memoryUndoNote:
      "Undo puts the words back; the memory stays marked as confirmed by you.",
    goalAdd: "New weekly goal",
    goalEdit: "Edit weekly goal",
    goalField: {
      title: "title",
      lines: "lines",
      note: "note",
      pillar: "objective",
    } as Record<string, string>,
    pillar: {
      of: "OF",
      work: "Work",
      ai: "AI",
      health: "Health",
    } as Record<string, string>,
    healthField: {
      day: "day",
      variant: "variant",
      minutes: "minutes",
      home_at: "home at",
    } as Record<string, string>,
    minutes: (count: number) => `${count} min`,
    homeAt: (time: string) => `home ${time}`,
    cleared: "cleared",
    none: "none",
    cardLabel: "Proposed changes",
    drop: "Drop from the board",
    undrop: "Put back on the board",
    unlinkGoal: "Unlink from its goal",
    aGoal: "a weekly goal",
    edit: "Proposed edit",
    archive: "Archive entry",
    unarchive: "Bring entry back",
    pin: "Pin entry",
    unpin: "Unpin entry",
    tick: "Include this change",
    changes: (count: number) => `${count} changes`,
    acceptN: (count: number) => `Accept ${count}`,
    dismissRest: (count: number) =>
      count === 1 ? "Dismiss the open one" : `Dismiss ${count} open`,
    undo: "Undo",
    undoAll: (count: number) => (count === 1 ? "Undo" : `Undo all ${count}`),
    undoFailed: "Couldn't undo. Try again.",
    edited: "Edited",
    reset: "Reset",
    resetLabel: "Put back what the agent proposed",
    noGoal: "No goal",
    noDue: "No due date",
    spotTop: "Top of the column",
    spotBottom: "Bottom of the column",
    spotAbove: (anchor: string) => `Above ${anchor}`,
    spotBelow: (anchor: string) => `Below ${anchor}`,
    healthKind: "Kind",
    healthKinds: {
      training: "Training",
      breath: "Breathwork",
      night_out: "Night out",
    } as Record<string, string>,
    minutesUnit: "min",
    week: "Week",
    weekOf: (day: string) => `Week of ${day}`,
  },
};

export type PlannerAskCopy = typeof en;

const zhCN: PlannerAskCopy = {
  title: "问日记",
  taskTitle: "代理",
  openTask: "问代理",
  newChat: "新对话",
  close: "关闭",
  empty: "问问你的日记、目标、任务或健康记录。代理读一切，只写你接受的内容。",
  emptyTask: "为这项任务要备注、标题、截止日期或安排。代理提议，你接受或忽略。",
  reading: "正在读你的日记",
  noAnswer: "没有收到回答，请再问一次。",
  placeholder: "提一个问题",
  placeholderTask: "要一份草稿，或一个改动",
  send: "发送",
  dropFile: "把文件拖到这里，放到任务上",
  filesOnTask: "已放到任务上",
  attach: "附加文件",
  dropFileChat: "把文件拖到这里，读进你的问题",
  filesForQuestion: "随问题一起发送",
  fileReading: "正在读取…",
  fileReady: "已读取",
  fileUnreadable: "无法读取",
  removeFile: "移除文件",
  fileTooLarge: (name: string, max: string) => `${name} 超过 ${max}`,
  fileTooMany: (max: number) => `每个问题最多 ${max} 个文件`,
  fileOnly: "这是一个文件。我该从中了解什么？",
  failed: "没能发出，请重试。",
  days: (from: string, to: string) => `日记 ${from} 至 ${to}`,
  proposal: {
    change: (field: string) => `提议的${field}`,
    newTask: "提议的任务",
    entry: "提议的日记",
    comment: "提议的评论",
    accept: "接受",
    dismiss: "忽略",
    accepted: "已接受",
    dismissed: "已忽略",
    expired: "已过期",
    reverted: "已撤销",
    failed: "没能应用，请重试。",
    field: {
      title: "标题",
      notes: "备注",
      priority: "优先级",
      due_at: "截止日期",
      effort: "工作量",
      start_date: "开始日期",
      column: "列",
      goal_id: "目标",
      dropped: "移出",
      place: "位置",
    },
    placeHeading: "在看板上移动",
    placeLine: (column: string, below: boolean, anchor: string) =>
      `移到${column}，在${anchor}${below ? "之下" : "之上"}`,
    link: "关联日记",
    unlink: "取消关联日记",
    memoryCorrect: "修正记忆",
    memoryForget: "忘掉记忆",
    healthFix: "修正健康记录",
    healthAdd: "添加健康记录",
    healthRemove: "移除健康记录",
    memoryUndoNote: "撤销会恢复原来的文字；这条记忆仍标记为由你确认。",
    goalAdd: "新周目标",
    goalEdit: "修改周目标",
    goalField: {
      title: "标题",
      lines: "条目",
      note: "备注",
      pillar: "目标方向",
    } as Record<string, string>,
    pillar: {
      of: "OF",
      work: "工作",
      ai: "AI",
      health: "健康",
    } as Record<string, string>,
    healthField: {
      day: "日期",
      variant: "类型",
      minutes: "分钟",
      home_at: "到家时间",
    } as Record<string, string>,
    minutes: (count: number) => `${count} 分钟`,
    homeAt: (time: string) => `${time} 到家`,
    cleared: "已清除",
    none: "无",
    cardLabel: "提议的改动",
    drop: "移出看板",
    undrop: "放回看板",
    unlinkGoal: "取消关联目标",
    aGoal: "一个周目标",
    edit: "提议的修改",
    archive: "归档日记",
    unarchive: "取消归档",
    pin: "置顶日记",
    unpin: "取消置顶",
    tick: "包含这项改动",
    changes: (count: number) => `${count} 项改动`,
    acceptN: (count: number) => `接受 ${count} 项`,
    dismissRest: (count: number) => `忽略 ${count} 项`,
    undo: "撤销",
    undoAll: (count: number) => (count === 1 ? "撤销" : `全部撤销 ${count} 项`),
    undoFailed: "没能撤销，请重试。",
    edited: "已修改",
    reset: "还原",
    resetLabel: "还原为代理的提议",
    noGoal: "无目标",
    noDue: "无截止日期",
    spotTop: "列顶部",
    spotBottom: "列底部",
    spotAbove: (anchor: string) => `在${anchor}之上`,
    spotBelow: (anchor: string) => `在${anchor}之下`,
    healthKind: "类型",
    healthKinds: {
      training: "训练",
      breath: "呼吸",
      night_out: "夜出",
    } as Record<string, string>,
    minutesUnit: "分钟",
    week: "周",
    weekOf: (day: string) => `${day} 起的一周`,
  },
};

export const plannerAskCopy = { en, zhCN };

export function usePlannerAskCopy(): PlannerAskCopy {
  const { locale } = useI18n();
  return locale === "zh-CN" ? zhCN : en;
}

/** The chat's own state: which conversation, whether a fresh one, the draft. */
export type PlannerAskChatState = {
  /** The conversation shown; null for the latest one. */
  conversation: string | null;
  /** A new chat with no question asked yet. */
  fresh: boolean;
  draft: string;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

type DiffLine = { kind: "same" | "gone" | "new"; text: string };

/** The lines an entry edit removes and adds, in order (a plain line LCS). */
export function plannerLineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Long entries: fall back to "all of it changed" rather than a big table.
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text) => ({ kind: "gone" as const, text })),
      ...b.map((text) => ({ kind: "new" as const, text })),
    ];
  }
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: "gone", text: a[i++] });
    } else {
      out.push({ kind: "new", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: "gone", text: a[i++] });
  while (j < b.length) out.push({ kind: "new", text: b[j++] });
  return out;
}

/** An entry edit as a before/after: changed lines with one line around them. */
function EntryDiff({ before, after }: { before: string; after: string }) {
  const lines = plannerLineDiff(before, after);
  const near = (index: number) =>
    lines[index].kind !== "same" ||
    (lines[index - 1]?.kind !== undefined &&
      lines[index - 1].kind !== "same") ||
    (lines[index + 1]?.kind !== undefined && lines[index + 1].kind !== "same");
  return (
    <div
      className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-border text-[13px] leading-relaxed"
      data-testid="planner-entry-diff"
    >
      {lines.map((line, index) =>
        near(index) ? (
          <p
            className={cn(
              "px-2 whitespace-pre-wrap [overflow-wrap:anywhere]",
              line.kind === "gone" && "text-muted-foreground line-through",
              line.kind === "new" && "bg-muted font-medium",
            )}
            data-kind={line.kind}
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id and never reorder
            key={index}
          >
            {line.text || " "}
          </p>
        ) : null,
      )}
    </div>
  );
}

/** Reads again whatever an accepted or undone action wrote. */
function usePlannerActionRefresh(task: string | null) {
  const queryClient = useQueryClient();
  return (action: PlannerAgentActionDto) => {
    if (
      action.kind === "entry_new" ||
      action.kind === "entry_edit" ||
      action.kind === "entry_state" ||
      action.kind === "entry_link"
    ) {
      void queryClient.invalidateQueries({ queryKey: ["memos"] });
      return;
    }
    if (action.kind === "memory_change") {
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
      return;
    }
    if (action.kind === "health_change") {
      void queryClient.invalidateQueries({ queryKey: ["health"] });
      return;
    }
    if (action.kind === "goal_change") {
      void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.goals });
      void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.boards });
      void queryClient.invalidateQueries({ queryKey: ["planner", "review"] });
      return;
    }
    const taskId =
      action.task_id ?? (action.kind === "task_new" ? action.landed_id : task);
    if (taskId) {
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.detail(taskId),
      });
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.history(taskId),
      });
    }
    void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.boards });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
  };
}

const failureText = (failure: unknown, fallback: string) =>
  failure instanceof ApiError && failure.status < 500
    ? failure.message
    : fallback;

/** What one action proposes: its heading line and its content. */
function PlannerProposalBody({
  action,
  today,
  copy,
  verdict,
  editing,
}: {
  action: PlannerAgentActionDto;
  today: string;
  copy: PlannerAskCopy;
  verdict: string | null;
  /** The open card's edits; null once the card is settled (no controls). */
  editing?: PlannerCardEditing | null;
}) {
  const strings = usePlannerStrings();
  const { change } = action;
  const keys = editing ? plannerCardEditableKeys(action) : [];
  /** The control for one editable key, or null when the card has none. */
  const control = (name: Parameters<typeof PlannerCardField>[0]["name"]) =>
    editing && keys.includes(name) ? (
      <PlannerCardField
        action={action}
        copy={copy}
        editing={editing}
        name={name}
        today={today}
      />
    ) : null;
  const differs = editing ? Object.keys(editing.edit).length > 0 : false;
  const editedTag = differs || (!editing && isRecord(change.edited));

  /** A field's value as a short line; an empty one reads "none" as the
   * value before and "cleared" as the value proposed. */
  const value = (field: string, raw: unknown, before = false) => {
    if (raw === null || raw === undefined || raw === "") {
      return before ? copy.proposal.none : copy.proposal.cleared;
    }
    switch (field) {
      case "priority": {
        const label = (strings.priority as Record<string, string>)[String(raw)];
        return label ?? String(raw);
      }
      case "due_at":
      case "start_date":
        return typeof raw === "string"
          ? plannerDueLabel(raw.slice(0, 10), today, strings)
          : String(raw);
      case "column": {
        const label = (strings.column as Record<string, string>)[String(raw)];
        return label ?? String(raw);
      }
      case "goal_id":
        return asString(change.goal_title) ?? copy.proposal.aGoal;
      default:
        return String(raw);
    }
  };

  const taskTitle = asString(change.task_title);
  const preview = asString(change.preview);
  let heading: string;
  switch (action.kind) {
    case "task_change":
      heading =
        action.field === "place"
          ? copy.proposal.placeHeading
          : action.field === "dropped"
            ? change.dropped
              ? copy.proposal.drop
              : copy.proposal.undrop
            : action.field === "goal_id" && change.goal_id === null
              ? copy.proposal.unlinkGoal
              : copy.proposal.change(
                  copy.proposal.field[action.field ?? "notes"],
                );
      break;
    case "task_new":
      heading = copy.proposal.newTask;
      break;
    case "comment_new":
      heading = copy.proposal.comment;
      break;
    case "entry_edit":
      heading = copy.proposal.edit;
      break;
    case "entry_link":
      heading = change.remove ? copy.proposal.unlink : copy.proposal.link;
      break;
    case "memory_change":
      heading =
        change.action === "forget"
          ? copy.proposal.memoryForget
          : copy.proposal.memoryCorrect;
      break;
    case "goal_change":
      heading =
        change.action === "add"
          ? copy.proposal.goalAdd
          : copy.proposal.goalEdit;
      break;
    case "health_change":
      heading =
        change.action === "add"
          ? copy.proposal.healthAdd
          : change.action === "remove"
            ? copy.proposal.healthRemove
            : copy.proposal.healthFix;
      break;
    case "entry_state":
      heading =
        typeof change.archived === "boolean"
          ? change.archived
            ? copy.proposal.archive
            : copy.proposal.unarchive
          : change.pinned
            ? copy.proposal.pin
            : copy.proposal.unpin;
      break;
    default:
      heading = copy.proposal.entry;
  }
  const subject =
    action.kind === "task_change" || action.kind === "comment_new"
      ? taskTitle
      : action.kind === "entry_state"
        ? preview
        : action.kind === "memory_change" && change.action === "forget"
          ? asString(change.label)
          : action.kind === "health_change"
            ? asString(change.label)
            : action.kind === "goal_change"
              ? [
                  asString(change.week),
                  change.action === "add"
                    ? asString(change.title)
                    : asString(change.goal_title),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : null;
  const shortField =
    action.kind === "task_change" &&
    action.field &&
    action.field !== "notes" &&
    action.field !== "place" &&
    action.field !== "dropped";

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <header className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          {heading}
        </span>
        {subject && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            · {subject}
          </span>
        )}
        {(editedTag || verdict) && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {editedTag && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
                {copy.proposal.edited}
              </span>
            )}
            {differs && editing && (
              <button
                aria-label={copy.proposal.resetLabel}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                type="button"
                onClick={editing.reset}
              >
                {copy.proposal.reset}
              </button>
            )}
            {verdict && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {verdict}
              </span>
            )}
          </span>
        )}
      </header>
      {shortField && action.field && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-medium [overflow-wrap:anywhere]">
          {"was" in change && (
            <span className="font-normal text-muted-foreground">
              {value(action.field, change.was, true)} →
            </span>
          )}
          {control(action.field as "title") ??
            value(action.field, change[action.field])}
        </div>
      )}
      {action.kind === "task_change" && action.field === "notes" && (
        <div className="[overflow-wrap:anywhere]">
          <PlannerMarkdown
            diaryLabel={copy.days}
            markdown={asString(change.notes) ?? ""}
          />
        </div>
      )}
      {action.kind === "task_change" &&
        action.field === "place" &&
        (editing && keys.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {control("column")}
            {control("spot")}
          </div>
        ) : (
          <p className="font-medium [overflow-wrap:anywhere]">
            {copy.proposal.placeLine(
              value("column", change.column),
              change.after_id !== undefined,
              asString(change.anchor_title) ?? "",
            )}
          </p>
        ))}
      {action.kind === "entry_link" && (
        <p className="font-medium [overflow-wrap:anywhere]">
          {asString(change.preview) ?? ""} →{" "}
          {asString(change.related_preview) ?? ""}
        </p>
      )}
      {action.kind === "memory_change" && change.action === "correct" && (
        <p className="font-medium [overflow-wrap:anywhere]">
          {isRecord(change.was) ? (asString(change.was.content) ?? "") : ""} →{" "}
          {asString(change.content) ?? ""}
        </p>
      )}
      {action.kind === "memory_change" && change.action === "correct" && (
        <p className="text-xs text-muted-foreground">
          {copy.proposal.memoryUndoNote}
        </p>
      )}
      {action.kind === "health_change" && change.action === "fix" && (
        <ul className="flex flex-col gap-0.5 font-medium [overflow-wrap:anywhere]">
          {Object.keys(copy.proposal.healthField)
            .filter((field) => field in change)
            .map((field) => (
              <li key={field}>
                {copy.proposal.healthField[field]}:{" "}
                {healthValue(
                  isRecord(change.was) ? change.was[field] : null,
                  copy,
                )}{" "}
                →{" "}
                {editing && keys.includes(field as "variant" | "minutes") ? (
                  <span className="inline-flex align-middle">
                    {control(field as "variant" | "minutes")}
                  </span>
                ) : (
                  healthValue(change[field], copy)
                )}
              </li>
            ))}
        </ul>
      )}
      {action.kind === "goal_change" && change.action === "add" && (
        <div className="flex flex-col gap-1 [overflow-wrap:anywhere]">
          {editing && keys.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {control("pillar")}
              {control("period_start")}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {copy.proposal.pillar[String(change.pillar)] ??
                String(change.pillar ?? "")}
            </p>
          )}
          {goalLines(change.lines).length > 0 && (
            <p className="font-medium">{goalLines(change.lines).join(" · ")}</p>
          )}
        </div>
      )}
      {action.kind === "goal_change" && change.action === "edit" && (
        <ul className="flex flex-col gap-0.5 font-medium [overflow-wrap:anywhere]">
          {Object.keys(copy.proposal.goalField)
            .filter((field) => field in change)
            .map((field) => (
              <li key={field}>
                {copy.proposal.goalField[field]}:{" "}
                {goalValue(
                  field,
                  isRecord(change.was) ? change.was[field] : null,
                  copy,
                )}{" "}
                →{" "}
                {editing && keys.includes(field as "pillar") ? (
                  <span className="inline-flex align-middle">
                    {control(field as "pillar")}
                  </span>
                ) : (
                  goalValue(field, change[field], copy)
                )}
              </li>
            ))}
        </ul>
      )}
      {action.kind === "health_change" &&
        change.action === "add" &&
        editing &&
        keys.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {control("kind")}
            {control("minutes")}
            {control("day")}
            {asString(change.home_at) && (
              <span className="text-xs text-muted-foreground">
                {copy.proposal.homeAt(asString(change.home_at) ?? "")}
              </span>
            )}
          </div>
        )}
      {action.kind === "health_change" &&
        change.action === "add" &&
        !(editing && keys.length > 0) && (
          <p className="font-medium [overflow-wrap:anywhere]">
            {[
              asString(change.variant),
              typeof change.minutes === "number"
                ? copy.proposal.minutes(change.minutes)
                : null,
              asString(change.home_at)
                ? copy.proposal.homeAt(asString(change.home_at) ?? "")
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      {action.kind === "task_new" && (
        <div className="flex flex-col gap-1 [overflow-wrap:anywhere]">
          {control("title") ?? (
            <p className="font-medium">{asString(change.title) ?? ""}</p>
          )}
          {asString(change.notes) && (
            <PlannerMarkdown
              diaryLabel={copy.days}
              markdown={asString(change.notes) ?? ""}
            />
          )}
          {editing && keys.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {control("column")}
              {control("due_at")}
              {control("goal_id")}
              {typeof change.priority === "string" &&
                change.priority !== "none" && (
                  <span className="text-xs text-muted-foreground">
                    {value("priority", change.priority)}
                  </span>
                )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {[
                change.due_at ? value("due_at", change.due_at) : null,
                change.priority && change.priority !== "none"
                  ? value("priority", change.priority)
                  : null,
                change.column ? value("column", change.column) : null,
                asString(change.goal_title),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
      )}
      {action.kind === "entry_new" && isRecord(change.link) && (
        <p className="text-xs text-muted-foreground">
          {plannerLinkReadLabel(change.link.read)}
        </p>
      )}
      {action.kind === "entry_new" && (
        <div className="[overflow-wrap:anywhere]">
          <PlannerMarkdown
            diaryLabel={copy.days}
            markdown={asString(change.content) ?? ""}
          />
        </div>
      )}
      {action.kind === "entry_edit" && (
        <EntryDiff
          after={asString(change.content) ?? ""}
          before={asString(change.was) ?? ""}
        />
      )}
      {action.kind === "comment_new" && (
        <p className="max-h-72 overflow-y-auto leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {asString(change.body) ?? ""}
        </p>
      )}
      {action.why && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {action.why}
        </p>
      )}
    </div>
  );
}

/** A goal's lines as plain text; a struck line keeps its text. */
function goalLines(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.flatMap((line) =>
        isRecord(line) && typeof line.text === "string" ? [line.text] : [],
      )
    : [];
}

/** A weekly goal's field as a short value: lines joined, a gap as "none". */
function goalValue(field: string, raw: unknown, copy: PlannerAskCopy) {
  if (field === "lines") {
    const lines = goalLines(raw);
    return lines.length ? lines.join(" · ") : copy.proposal.none;
  }
  if (raw === null || raw === undefined || raw === "") {
    return copy.proposal.none;
  }
  return field === "pillar"
    ? (copy.proposal.pillar[String(raw)] ?? String(raw))
    : String(raw);
}

/** A health row's field as a short value: minutes with their unit, a gap as "none". */
function healthValue(raw: unknown, copy: PlannerAskCopy) {
  if (raw === null || raw === undefined || raw === "") {
    return copy.proposal.none;
  }
  return typeof raw === "number" ? copy.proposal.minutes(raw) : String(raw);
}

function verdictOf(action: PlannerAgentActionDto, copy: PlannerAskCopy) {
  switch (action.state) {
    case "accepted":
      return copy.proposal.accepted;
    case "dismissed":
      return copy.proposal.dismissed;
    case "expired":
      return copy.proposal.expired;
    case "reverted":
      return copy.proposal.reverted;
    default:
      return null;
  }
}

/**
 * One proposed action, as a card: what it would change, why, and the verdict,
 * with Accept and Dismiss while open and Undo once accepted. Also used under a
 * task's files for the comment read from one (task-panel-attachments.tsx).
 */
export function PlannerProposalCard({
  action,
  task,
  today,
  copy,
  onSettled,
}: {
  action: PlannerAgentActionDto;
  task: string | null;
  today: string;
  copy: PlannerAskCopy;
  onSettled: (action: PlannerAgentActionDto) => void;
}) {
  const refresh = usePlannerActionRefresh(task);
  const [error, setError] = useState<string | null>(null);
  const cardEdits = usePlannerCardEdits();
  const open = action.state === "open";
  const goals = usePlannerGoalChoices(
    open && plannerCardEditableKeys(action).includes("goal_id"),
    today,
  );
  const edit = plannerCardEditBody(action, cardEdits.edits[action.id]);
  const settle = useMutation({
    mutationFn: (state: "accepted" | "dismissed" | "reverted") =>
      state === "reverted"
        ? plannerRevertActionRequest(action.id, { today })
        : plannerSettleActionRequest(action.id, {
            state,
            today,
            ...(state === "accepted" && edit ? { edit } : {}),
          }),
    onSuccess: (response, state) => {
      setError(null);
      onSettled(response.action);
      if (state !== "dismissed") refresh(response.action);
    },
    onError: (failure, state) => {
      setError(
        failureText(
          failure,
          state === "reverted"
            ? copy.proposal.undoFailed
            : copy.proposal.failed,
        ),
      );
    },
  });

  return (
    <article
      aria-label={copy.proposal.cardLabel}
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border bg-background px-3 py-2.5 text-sm",
        !open && action.state !== "accepted" && "opacity-70",
      )}
      data-state={action.state}
      data-testid="planner-proposal"
    >
      <PlannerProposalBody
        action={action}
        copy={copy}
        editing={
          open
            ? {
                edit: cardEdits.edits[action.id] ?? {},
                set: (patch) => cardEdits.set(action, patch),
                reset: () => cardEdits.reset(action.id),
                goals,
              }
            : null
        }
        today={today}
        verdict={verdictOf(action, copy)}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {open && (
        <div className="flex items-center gap-1.5">
          <Button
            disabled={settle.isPending}
            size="sm"
            type="button"
            onClick={() => settle.mutate("accepted")}
          >
            <CheckIcon data-icon="inline-start" />
            {copy.proposal.accept}
          </Button>
          <Button
            disabled={settle.isPending}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => settle.mutate("dismissed")}
          >
            <XIcon data-icon="inline-start" />
            {copy.proposal.dismiss}
          </Button>
        </div>
      )}
      {action.state === "accepted" && (
        <div className="flex items-center gap-1.5">
          <Button
            disabled={settle.isPending}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => settle.mutate("reverted")}
          >
            <Undo2Icon data-icon="inline-start" />
            {copy.proposal.undo}
          </Button>
        </div>
      )}
    </article>
  );
}

/**
 * Everything the agent proposed in one answer, as one card (design option B):
 * a tick box per change, Accept for the ticked ones, Dismiss for the rest, and
 * Undo all once accepted. Each accept is still its own write, through the same
 * route as a single card, one after another, so a refused row (the record
 * changed since) stops nothing else and says why on its own line.
 */
export function PlannerChangeSet({
  actions,
  task,
  today,
  copy,
  onSettled,
}: {
  actions: PlannerAgentActionDto[];
  task: string | null;
  today: string;
  copy: PlannerAskCopy;
  onSettled: (action: PlannerAgentActionDto) => void;
}) {
  const refresh = usePlannerActionRefresh(task);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const cardEdits = usePlannerCardEdits();
  const goals = usePlannerGoalChoices(
    actions.length > 1 &&
      actions.some(
        (action) =>
          action.state === "open" &&
          plannerCardEditableKeys(action).includes("goal_id"),
      ),
    today,
  );
  if (actions.length === 1) {
    return (
      <PlannerProposalCard
        action={actions[0]}
        copy={copy}
        task={task}
        today={today}
        onSettled={onSettled}
      />
    );
  }

  const open = actions.filter((action) => action.state === "open");
  const ticked = open.filter((action) => !unticked.has(action.id));
  const accepted = actions.filter((action) => action.state === "accepted");

  const run = async (
    list: PlannerAgentActionDto[],
    step: (action: PlannerAgentActionDto) => Promise<PlannerAgentActionDto>,
    fallback: string,
  ) => {
    setBusy(true);
    const next: Record<string, string> = {};
    for (const action of list) {
      try {
        const settled = await step(action);
        onSettled(settled);
        if (settled.state !== "dismissed") refresh(settled);
      } catch (failure) {
        next[action.id] = failureText(failure, fallback);
      }
    }
    setErrors(next);
    setBusy(false);
  };

  const editOf = (action: PlannerAgentActionDto) => {
    const edit = plannerCardEditBody(action, cardEdits.edits[action.id]);
    return edit ? { edit } : {};
  };
  const accept = () =>
    run(
      ticked,
      async (action) =>
        (
          await plannerSettleActionRequest(action.id, {
            state: "accepted",
            today,
            ...editOf(action),
          })
        ).action,
      copy.proposal.failed,
    );
  const dismiss = () =>
    run(
      open,
      async (action) =>
        (
          await plannerSettleActionRequest(action.id, {
            state: "dismissed",
            today,
          })
        ).action,
      copy.proposal.failed,
    );
  // Undo goes newest first, so two changes to one task come back in order.
  const undoAll = () =>
    run(
      [...accepted].reverse(),
      async (action) =>
        (await plannerRevertActionRequest(action.id, { today })).action,
      copy.proposal.undoFailed,
    );

  return (
    <article
      aria-label={copy.proposal.cardLabel}
      className="flex flex-col gap-2 rounded-xl border border-border bg-background px-3 py-2.5 text-sm"
      data-testid="planner-change-set"
    >
      <p className="text-xs font-medium text-muted-foreground">
        {copy.proposal.changes(actions.length)}
      </p>
      <ul className="flex flex-col divide-y divide-border">
        {actions.map((action) => {
          const isOpen = action.state === "open";
          const id = `planner-change-${action.id}`;
          return (
            <li
              className={cn(
                "flex items-start gap-2 py-2",
                !isOpen && action.state !== "accepted" && "opacity-70",
              )}
              data-state={action.state}
              data-testid="planner-proposal"
              key={action.id}
            >
              {isOpen ? (
                <input
                  aria-label={copy.proposal.tick}
                  checked={!unticked.has(action.id)}
                  className="mt-0.5 size-4 shrink-0 accent-foreground"
                  disabled={busy}
                  id={id}
                  type="checkbox"
                  onChange={(event) => {
                    const on = event.target.checked;
                    setUnticked((current) => {
                      const next = new Set(current);
                      if (on) next.delete(action.id);
                      else next.add(action.id);
                      return next;
                    });
                  }}
                />
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <PlannerProposalBody
                  action={action}
                  copy={copy}
                  editing={
                    isOpen
                      ? {
                          edit: cardEdits.edits[action.id] ?? {},
                          set: (patch) => cardEdits.set(action, patch),
                          reset: () => cardEdits.reset(action.id),
                          goals,
                        }
                      : null
                  }
                  today={today}
                  verdict={verdictOf(action, copy)}
                />
                {errors[action.id] && (
                  <p className="text-xs text-destructive">
                    {errors[action.id]}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {open.length > 0 && (
        <div className="flex items-center gap-1.5">
          <Button
            disabled={busy || ticked.length === 0}
            size="sm"
            type="button"
            onClick={() => void accept()}
          >
            <CheckIcon data-icon="inline-start" />
            {copy.proposal.acceptN(ticked.length)}
          </Button>
          <Button
            disabled={busy}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void dismiss()}
          >
            <XIcon data-icon="inline-start" />
            {copy.proposal.dismissRest(open.length)}
          </Button>
        </div>
      )}
      {open.length === 0 && accepted.length > 0 && (
        <div className="flex items-center gap-1.5">
          <Button
            disabled={busy}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void undoAll()}
          >
            <Undo2Icon data-icon="inline-start" />
            {copy.proposal.undoAll(accepted.length)}
          </Button>
        </div>
      )}
    </article>
  );
}

/**
 * Groups a conversation's actions by the answer they were proposed in: the
 * actions filed after one question and before the next.
 */
export function plannerGroupActions(
  actions: readonly PlannerAgentActionDto[],
  questions: readonly string[],
): PlannerAgentActionDto[][] {
  const groups = new Map<number, PlannerAgentActionDto[]>();
  for (const action of actions) {
    let turn = -1;
    for (const [index, asked] of questions.entries()) {
      if (asked <= action.created_at) turn = index;
    }
    const list = groups.get(turn) ?? [];
    list.push(action);
    groups.set(turn, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, list]) => list);
}

export function PlannerAskChat({
  task = null,
  state,
  onChange,
  className,
}: {
  /** The task the chat is held from; null for Ask my diary's global chat. */
  task?: string | null;
  state: PlannerAskChatState;
  onChange: (patch: Partial<PlannerAskChatState>) => void;
  className?: string;
}) {
  const copy = usePlannerAskCopy();
  const today = usePlannerToday();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const key = state.fresh ? null : state.conversation;
  const query = useQuery({
    queryKey: plannerQueryKeys.ask(key, task),
    queryFn: () => plannerFetchAsk(today, key, task),
    enabled: !state.fresh,
    refetchInterval: (current) =>
      current.state.data?.status === "running" ? 3_000 : false,
    retry: false,
  });
  const data = state.fresh ? undefined : query.data;
  const conversation = data?.conversation ?? null;
  const messages = data?.messages ?? [];
  const actions = data?.actions ?? [];
  const running = data?.status === "running";

  const remember = (response: PlannerAskResponse) => {
    queryClient.setQueryData(
      plannerQueryKeys.ask(response.conversation, task),
      response,
    );
    queryClient.setQueryData(plannerQueryKeys.ask(null, task), response);
  };

  const chatFiles = usePlannerChatFiles({
    tooLarge: copy.fileTooLarge,
    tooMany: copy.fileTooMany,
  });
  const send = useMutation({
    mutationFn: (input: {
      question: string;
      files: Array<{ filename: string; text: string }>;
    }) =>
      plannerAskRequest({
        today,
        text: input.question,
        ...(input.files.length > 0 ? { files: input.files } : {}),
        ...(conversation ? { conversation } : {}),
        ...(task && !conversation ? { task } : {}),
      }),
    onSuccess: (response) => {
      remember(response);
      chatFiles.clear();
      onChange({
        conversation: response.conversation,
        fresh: false,
        draft: "",
      });
      setError(null);
    },
    onError: (failure) => {
      // A 503 says why (not set up, or the month's budget is spent); a 409
      // that the last question is still being answered.
      setError(
        failure instanceof ApiError &&
          (failure.status === 503 || failure.status === 409)
          ? failure.message
          : copy.failed,
      );
    },
  });

  // Reads the cache, not this render's data: a card settles several rows in
  // a row, and each must build on the one before.
  const settled = (action: PlannerAgentActionDto) => {
    const current =
      queryClient.getQueryData<PlannerAskResponse>(
        plannerQueryKeys.ask(key, task),
      ) ?? data;
    if (!current) return;
    remember({
      ...current,
      actions: current.actions.map((each) =>
        each.id === action.id ? action : each,
      ),
    });
  };

  // Files dropped or pasted into a task's chat go on the task; the ones from
  // this chat are listed by name, with their state from the cached detail.
  const files = usePlannerAttachmentActions(task ?? "");
  const [dropped, setDropped] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const detail = useQuery({
    queryKey: plannerQueryKeys.detail(task ?? ""),
    queryFn: () => plannerFetchTaskDetail(task ?? ""),
    enabled: task !== null && dropped.length > 0,
    staleTime: 0,
  });
  const strings = usePlannerStrings();
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = (list: readonly File[]) => {
    if (list.length === 0) return;
    if (!task) {
      chatFiles.add(list);
      return;
    }
    setDropped((names) => [
      ...names,
      ...list.map((file) => file.name).filter((name) => !names.includes(name)),
    ]);
    files.actions.add(list);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setOver(false);
    addFiles(Array.from(event.dataTransfer?.files ?? []));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const list = Array.from(event.clipboardData?.files ?? []);
    if (list.length === 0) return;
    event.preventDefault();
    addFiles(list);
  };
  const onTask = (detail.data?.attachments ?? []).filter((entry) =>
    dropped.includes(entry.filename),
  );

  const busy = running || send.isPending;
  const attached = task ? [] : chatFiles.ready;
  const canSend =
    !busy &&
    !chatFiles.reading &&
    (state.draft.trim().length > 0 || attached.length > 0);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    send.mutate({
      question: state.draft.trim() || copy.fileOnly,
      files: attached,
    });
  };

  // The newest message stays in view.
  const count = messages.length + actions.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the chat grows
  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [count, running]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target around the chat; the question box below is the control
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDrop={onDrop}
    >
      <div
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
        ref={scrollRef}
      >
        {count === 0 && !busy && (
          <p className="text-sm text-muted-foreground">
            {task ? copy.emptyTask : copy.empty}
          </p>
        )}
        {messages.map((message) =>
          message.role === "owner" ? (
            <div
              className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
              key={message.id}
            >
              {message.text}
            </div>
          ) : (
            <div
              className="max-w-full text-sm [overflow-wrap:anywhere]"
              key={message.id}
            >
              <PlannerMarkdown diaryLabel={copy.days} markdown={message.text} />
            </div>
          ),
        )}
        {plannerGroupActions(
          actions,
          messages
            .filter((message) => message.role === "owner")
            .map((message) => message.created_at),
        ).map((group) => (
          <PlannerChangeSet
            actions={group}
            copy={copy}
            key={group[0].id}
            task={task}
            today={today}
            onSettled={settled}
          />
        ))}
        {busy && (
          <span className="planner-thinking text-[13px] text-muted-foreground">
            {copy.reading}
          </span>
        )}
        {!busy && data?.status === "failed" && (
          <p className="text-[13px] text-muted-foreground">{copy.noAnswer}</p>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
      </div>
      {task && (onTask.length > 0 || files.uploading.length > 0) && (
        <ul
          className="flex flex-col gap-1 border-t border-border px-4 py-2 text-[13px] text-muted-foreground"
          data-testid="planner-ask-files"
        >
          <li className="font-medium">{copy.filesOnTask}</li>
          {onTask.map((entry) => (
            <li className="flex items-center gap-1.5" key={entry.id}>
              {entry.read_state === "pending" && (
                <Loader2Icon className="size-3 shrink-0 animate-spin" />
              )}
              <span className="truncate">
                {entry.filename} ·{" "}
                {plannerAttachmentState(entry, strings.panel.attachments)}
              </span>
            </li>
          ))}
          {files.uploading.map((entry) => (
            <li className="flex items-center gap-1.5" key={entry.key}>
              <Loader2Icon className="size-3 shrink-0 animate-spin" />
              <span className="truncate">
                {entry.name} · {strings.panel.attachments.uploading}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!task && (chatFiles.files.length > 0 || chatFiles.notice) && (
        <ul
          className="flex flex-col gap-1 border-t border-border px-4 py-2 text-[13px] text-muted-foreground"
          data-testid="planner-ask-chat-files"
        >
          {chatFiles.files.length > 0 && (
            <li className="font-medium">{copy.filesForQuestion}</li>
          )}
          {chatFiles.files.map((entry) => (
            <li className="flex items-center gap-1.5" key={entry.key}>
              {entry.state === "reading" && (
                <Loader2Icon className="size-3 shrink-0 animate-spin" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {entry.filename} ·{" "}
                {entry.state === "reading"
                  ? copy.fileReading
                  : entry.state === "ready"
                    ? copy.fileReady
                    : copy.fileUnreadable}
              </span>
              <Button
                aria-label={copy.removeFile}
                size="icon-xs"
                title={copy.removeFile}
                type="button"
                variant="ghost"
                onClick={() => chatFiles.remove(entry.key)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
          {chatFiles.notice && (
            <li className="text-destructive">{chatFiles.notice}</li>
          )}
        </ul>
      )}
      <form
        className={cn(
          "flex items-end gap-2 border-t border-border p-3",
          over && "bg-muted/60",
        )}
        onSubmit={submit}
      >
        <Textarea
          aria-label={task ? copy.placeholderTask : copy.placeholder}
          className="max-h-32 min-h-10 resize-none bg-background"
          maxLength={4000}
          placeholder={
            task
              ? over
                ? copy.dropFile
                : copy.placeholderTask
              : over
                ? copy.dropFileChat
                : copy.placeholder
          }
          rows={2}
          value={state.draft}
          onChange={(event) => onChange({ draft: event.target.value })}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <input
          className="sr-only"
          data-testid="planner-ask-file-input"
          multiple
          ref={fileInput}
          tabIndex={-1}
          type="file"
          onChange={(event) => {
            const list = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            addFiles(list);
          }}
        />
        <Button
          aria-label={copy.attach}
          size="icon"
          title={copy.attach}
          type="button"
          variant="ghost"
          onClick={() => fileInput.current?.click()}
        >
          <PaperclipIcon />
        </Button>
        <Button
          aria-label={copy.send}
          disabled={!canSend}
          size="icon"
          type="submit"
        >
          <ArrowUpIcon />
        </Button>
      </form>
    </div>
  );
}

/** fork: link summaries. What the card says about how much was read. */
export function plannerLinkReadLabel(read: unknown): string {
  switch (read) {
    case "full":
      return "Link summary · read in full";
    case "partial":
      return "Link summary · only part of it could be read";
    default:
      return "Link summary · only the title and description could be read";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
