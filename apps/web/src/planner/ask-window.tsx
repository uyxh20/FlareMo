import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpIcon, XIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";
import {
  plannerAskRequest,
  plannerEndAskRequest,
  plannerFetchAsk,
} from "./ask-api";
import { plannerSetAsk, usePlannerAsk } from "./ask-store";
import { plannerQueryKeys } from "./query-keys";
import { PlannerMarkdown } from "./review-markdown";
import { usePlannerToday } from "./use-planner-clock";
import "./goals.css";

// Ask my diary's window (fork-owned add-on, docs/fork-general-agent.md): a
// small chat that opens from the sidebar over whatever page is showing. The
// general agent answers from the owner's whole record and changes nothing; an
// answer takes from a few seconds to a minute, and the window asks every few
// seconds until it is in. Loaded only when the window first opens.

const COPY = {
  en: {
    title: "Ask my diary",
    newChat: "New chat",
    close: "Close",
    empty:
      "Ask about your diary, goals, tasks or health. The agent reads everything and changes nothing.",
    reading: "Reading your diary",
    noAnswer: "No answer came. Ask again.",
    placeholder: "Ask a question",
    send: "Send",
    failed: "Couldn't ask. Try again.",
    days: (from: string, to: string) => `Diary ${from} to ${to}`,
  },
  zhCN: {
    title: "问日记",
    newChat: "新对话",
    close: "关闭",
    empty: "问问你的日记、目标、任务或健康记录。代理只读，不做任何修改。",
    reading: "正在读你的日记",
    noAnswer: "没有收到回答，请再问一次。",
    placeholder: "提一个问题",
    send: "发送",
    failed: "没能发出，请重试。",
    days: (from: string, to: string) => `日记 ${from} 至 ${to}`,
  },
} as const;

export function PlannerAskWindow() {
  const { locale } = useI18n();
  const text = locale === "zh-CN" ? COPY.zhCN : COPY.en;
  const today = usePlannerToday();
  const ask = usePlannerAsk();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const key = ask.fresh ? null : ask.conversation;
  const query = useQuery({
    queryKey: plannerQueryKeys.ask(key),
    queryFn: () => plannerFetchAsk(today, key),
    enabled: !ask.fresh,
    refetchInterval: (current) =>
      current.state.data?.status === "running" ? 3_000 : false,
    retry: false,
  });
  const data = ask.fresh ? undefined : query.data;
  const conversation = data?.conversation ?? null;
  const messages = data?.messages ?? [];
  const running = data?.status === "running";

  const send = useMutation({
    mutationFn: (question: string) =>
      plannerAskRequest({
        today,
        text: question,
        ...(conversation ? { conversation } : {}),
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(
        plannerQueryKeys.ask(response.conversation),
        response,
      );
      queryClient.setQueryData(plannerQueryKeys.ask(null), response);
      plannerSetAsk({
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
          : text.failed,
      );
    },
  });

  const busy = running || send.isPending;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const question = ask.draft.trim();
    if (!question || busy) return;
    send.mutate(question);
  };

  const newChat = () => {
    if (conversation) void plannerEndAskRequest(conversation).catch(() => {});
    plannerSetAsk({ fresh: true, conversation: null, draft: "" });
    setError(null);
  };

  // Escape closes the window, as it would a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") plannerSetAsk({ open: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The newest message stays in view.
  const count = messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the chat grows
  useEffect(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [count, running]);

  return (
    <div
      aria-label={text.title}
      className="fixed right-4 bottom-4 z-50 flex h-[min(560px,calc(100dvh-2rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      data-testid="planner-ask-window"
      role="dialog"
    >
      <header className="flex items-center gap-1.5 border-b border-border py-2 pr-2 pl-4">
        <span className="font-semibold">{text.title}</span>
        <Button
          className="ml-auto"
          disabled={ask.fresh || count === 0}
          size="sm"
          variant="ghost"
          onClick={newChat}
        >
          {text.newChat}
        </Button>
        <Button
          aria-label={text.close}
          size="icon-sm"
          variant="ghost"
          onClick={() => plannerSetAsk({ open: false })}
        >
          <XIcon />
        </Button>
      </header>
      <div
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
        ref={scrollRef}
      >
        {count === 0 && !busy && (
          <p className="text-sm text-muted-foreground">{text.empty}</p>
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
              <PlannerMarkdown diaryLabel={text.days} markdown={message.text} />
            </div>
          ),
        )}
        {busy && (
          <span className="planner-thinking text-[13px] text-muted-foreground">
            {text.reading}
          </span>
        )}
        {!busy && data?.status === "failed" && (
          <p className="text-[13px] text-muted-foreground">{text.noAnswer}</p>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
      </div>
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={submit}
      >
        <Textarea
          aria-label={text.placeholder}
          className="max-h-32 min-h-10 resize-none bg-background"
          maxLength={4000}
          placeholder={text.placeholder}
          rows={2}
          value={ask.draft}
          onChange={(event) => plannerSetAsk({ draft: event.target.value })}
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
          aria-label={text.send}
          disabled={!ask.draft.trim() || busy}
          size="icon"
          type="submit"
        >
          <ArrowUpIcon />
        </Button>
      </form>
    </div>
  );
}
