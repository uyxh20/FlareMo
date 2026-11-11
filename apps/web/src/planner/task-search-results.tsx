import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2Icon, CircleIcon, ListTodoIcon } from "lucide-react";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { plannerSearchTasksRequest } from "./api";
import { plannerTaskParamFromId } from "./panel-model";

// The diary search's task hits (fork-owned add-on, docs/fork-data-sources.md).
// It replaces upstream's TaskSearchResults in App.tsx: the same box above the
// entries, but the server matches comments as well as titles and notes, the
// matching words are shown, and a hit opens the task's panel in the cockpit
// (upstream's linked to the Projects page, which the fork hides).

/** The words of `text` around `needle`, with the needle marked. */
export function plannerHighlight(text: string, needle: string) {
  const at = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (!needle || at < 0) return [text];
  return [
    text.slice(0, at),
    <mark
      className="rounded-sm bg-brand-200/60 px-0.5 text-inherit dark:bg-brand-400/30"
      key="m"
    >
      {text.slice(at, at + needle.length)}
    </mark>,
    text.slice(at + needle.length),
  ];
}

const WHERE = { title: "", notes: "notes", comment: "comment" } as const;

export function PlannerTaskSearchResults({ query }: { query: string }) {
  const { t } = useI18n();
  const needle = query.replace(/\s+/g, " ").trim();
  const search = useQuery({
    queryKey: ["planner", "task-search", needle],
    queryFn: () => plannerSearchTasksRequest(needle),
    enabled: needle.length > 0,
    staleTime: 10_000,
  });
  const hits = search.data?.tasks ?? [];
  if (!hits.length) return null;

  return (
    <div
      className="mb-3 rounded-xl border border-border/50 bg-card/60 px-3.5 py-3 text-card-foreground"
      data-testid="planner-task-search"
    >
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListTodoIcon className="size-3.5" />
        {t("search.taskResults")}
      </h2>
      <ul className="mt-1.5 flex flex-col divide-y divide-border/40">
        {hits.map((hit) => (
          <li key={hit.id}>
            <Link
              className="flex items-start gap-2 py-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              search={{ task: plannerTaskParamFromId(hit.id) }}
              to="/cockpit"
            >
              {hit.status === "done" ? (
                <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <CircleIcon className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-foreground",
                    hit.status === "done" && "line-through",
                  )}
                >
                  {plannerHighlight(hit.title, needle)}
                </span>
                {hit.snippet && (
                  <span className="block text-xs leading-snug">
                    {WHERE[hit.match] && (
                      <span className="mr-1.5 rounded bg-muted px-1 py-px text-[11px]">
                        {WHERE[hit.match]}
                        {hit.comment_at
                          ? ` · ${hit.comment_at.slice(0, 10)}`
                          : ""}
                      </span>
                    )}
                    {plannerHighlight(hit.snippet, needle)}
                  </span>
                )}
              </span>
              {hit.due_at && (
                <span className="ml-auto shrink-0 text-xs tabular-nums">
                  {hit.due_at}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
