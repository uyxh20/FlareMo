import type {
  PlannerAgentActionDto,
  PlannerAskResponse,
} from "@flaremo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpIcon, CheckIcon, XIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import {
  plannerAskRequest,
  plannerFetchAsk,
  plannerSettleActionRequest,
} from "./ask-api";
import { plannerDueLabel } from "./dates";
import { plannerQueryKeys } from "./query-keys";
import { PlannerMarkdown } from "./review-markdown";
import { usePlannerStrings } from "./strings";
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
  failed: "Couldn't ask. Try again.",
  days: (from: string, to: string) => `Diary ${from} to ${to}`,
  proposal: {
    change: (field: string) => `Proposed ${field}`,
    newTask: "Proposed task",
    entry: "Proposed diary entry",
    accept: "Accept",
    dismiss: "Dismiss",
    accepted: "Accepted",
    dismissed: "Dismissed",
    expired: "Expired",
    reverted: "Reverted",
    failed: "Couldn't apply. Try again.",
    field: {
      title: "title",
      notes: "notes",
      priority: "priority",
      due_at: "due date",
      effort: "effort",
      start_date: "start date",
      column: "column",
    },
    cleared: "cleared",
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
  failed: "没能发出，请重试。",
  days: (from: string, to: string) => `日记 ${from} 至 ${to}`,
  proposal: {
    change: (field: string) => `提议的${field}`,
    newTask: "提议的任务",
    entry: "提议的日记",
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
    },
    cleared: "已清除",
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

/** One proposed action, as a card: what it would change, why, and the verdict. */
function ProposalCard({
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
  const strings = usePlannerStrings();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const settle = useMutation({
    mutationFn: (state: "accepted" | "dismissed") =>
      plannerSettleActionRequest(action.id, { state, today }),
    onSuccess: (response, state) => {
      setError(null);
      onSettled(response.action);
      if (state !== "accepted") return;
      // The accept wrote something: the task (or the new one), the board, the
      // History and upstream's lists read it again; a diary entry, the memos.
      const taskId = response.action.task_id ?? task;
      if (response.action.kind === "entry_new") {
        void queryClient.invalidateQueries({ queryKey: ["memos"] });
        return;
      }
      if (taskId) {
        void queryClient.invalidateQueries({
          queryKey: plannerQueryKeys.detail(taskId),
        });
        void queryClient.invalidateQueries({
          queryKey: plannerQueryKeys.history(taskId),
        });
      }
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.boards,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
    onError: (failure) => {
      setError(
        failure instanceof ApiError && failure.status < 500
          ? failure.message
          : copy.proposal.failed,
      );
    },
  });

  const { change } = action;
  const fieldName = action.field
    ? copy.proposal.field[action.field]
    : copy.proposal.field.notes;
  const heading =
    action.kind === "task_change"
      ? copy.proposal.change(fieldName)
      : action.kind === "task_new"
        ? copy.proposal.newTask
        : copy.proposal.entry;

  /** A field's proposed value as a short line, or as rendered notes. */
  const value = (field: string, raw: unknown) => {
    if (raw === null || raw === undefined || raw === "") {
      return copy.proposal.cleared;
    }
    switch (field) {
      case "priority": {
        const label = (strings.priority as Record<string, string>)[String(raw)];
        return label ?? String(raw);
      }
      case "due_at":
      case "start_date":
        return typeof raw === "string"
          ? plannerDueLabel(raw, today, strings)
          : String(raw);
      case "column": {
        const label = (strings.column as Record<string, string>)[String(raw)];
        return label ?? String(raw);
      }
      default:
        return String(raw);
    }
  };

  const open = action.state === "open";
  const verdict =
    action.state === "accepted"
      ? copy.proposal.accepted
      : action.state === "dismissed"
        ? copy.proposal.dismissed
        : action.state === "expired"
          ? copy.proposal.expired
          : action.state === "reverted"
            ? copy.proposal.reverted
            : null;

  return (
    <article
      aria-label={heading}
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border bg-background px-3 py-2.5 text-sm",
        !open && "opacity-70",
      )}
      data-state={action.state}
      data-testid="planner-proposal"
    >
      <header className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {heading}
        </span>
        {verdict && (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {verdict}
          </span>
        )}
      </header>
      {action.kind === "task_change" && action.field && (
        <div className="[overflow-wrap:anywhere]">
          {action.field === "notes" ? (
            <PlannerMarkdown
              diaryLabel={copy.days}
              markdown={asString(change.notes) ?? ""}
            />
          ) : (
            <p className="font-medium">
              {value(action.field, change[action.field])}
            </p>
          )}
        </div>
      )}
      {action.kind === "task_new" && (
        <div className="flex flex-col gap-1 [overflow-wrap:anywhere]">
          <p className="font-medium">{asString(change.title) ?? ""}</p>
          {asString(change.notes) && (
            <PlannerMarkdown
              diaryLabel={copy.days}
              markdown={asString(change.notes) ?? ""}
            />
          )}
          <p className="text-xs text-muted-foreground">
            {[
              change.due_at ? value("due_at", change.due_at) : null,
              change.priority && change.priority !== "none"
                ? value("priority", change.priority)
                : null,
              change.column ? value("column", change.column) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      )}
      {action.kind === "entry_new" && (
        <div className="[overflow-wrap:anywhere]">
          <PlannerMarkdown
            diaryLabel={copy.days}
            markdown={asString(change.content) ?? ""}
          />
        </div>
      )}
      {action.why && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {action.why}
        </p>
      )}
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
    </article>
  );
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

  const send = useMutation({
    mutationFn: (question: string) =>
      plannerAskRequest({
        today,
        text: question,
        ...(conversation ? { conversation } : {}),
        ...(task && !conversation ? { task } : {}),
      }),
    onSuccess: (response) => {
      remember(response);
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

  const settled = (action: PlannerAgentActionDto) => {
    if (!data) return;
    remember({
      ...data,
      actions: data.actions.map((each) =>
        each.id === action.id ? action : each,
      ),
    });
  };

  const busy = running || send.isPending;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const question = state.draft.trim();
    if (!question || busy) return;
    send.mutate(question);
  };

  // The newest message stays in view.
  const count = messages.length + actions.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the chat grows
  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [count, running]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
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
        {actions.map((action) => (
          <ProposalCard
            action={action}
            copy={copy}
            key={action.id}
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
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={submit}
      >
        <Textarea
          aria-label={task ? copy.placeholderTask : copy.placeholder}
          className="max-h-32 min-h-10 resize-none bg-background"
          maxLength={4000}
          placeholder={task ? copy.placeholderTask : copy.placeholder}
          rows={2}
          value={state.draft}
          onChange={(event) => onChange({ draft: event.target.value })}
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
        <Button
          aria-label={copy.send}
          disabled={!state.draft.trim() || busy}
          size="icon"
          type="submit"
        >
          <ArrowUpIcon />
        </Button>
      </form>
    </div>
  );
}
