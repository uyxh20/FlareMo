import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BrainIcon,
  CalendarDaysIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderKanbanIcon,
  FootprintsIcon,
  HashIcon,
  LayoutGridIcon,
  MicIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getCaptureStatus,
  type MemoSpace,
  type MemoStatsResponse,
  type TagHierarchyNode,
} from "@/api";
import { authClient } from "@/auth-client";
import { MiniCalendarReminders } from "@/components/flaremo-mini-calendar-panel";
import { FlareMoTimeHorizon } from "@/components/flaremo-time-horizon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";
import { currentStreak } from "@/lib/activity";
import { queryKeys } from "@/lib/query-keys";
import { TIMELINE_SEARCH } from "@/lib/timeline-search";
import { cn } from "@/lib/utils";

export type ExplorerView = "all" | "archived" | "trashed";

export type TimeView = "trend" | "calendar";

type FlareMoExplorerProps = {
  activeTag?: string;
  footer?: ReactNode;
  /** Top-left slot (the member menu trigger). Branding lives in the favicon
   * and share pages, not here. */
  header?: ReactNode;
  /** Top-right slot (e.g. the desktop collapse-sidebar button). */
  headerAction?: ReactNode;
  hierarchy: TagHierarchyNode[];
  hierarchyPending?: boolean;
  stats: MemoStatsResponse;
  /** Viewer's IANA zone + space scope: the year view anchors its own stats
   * query with them (issue #144). */
  timeZone: string;
  space?: MemoSpace;
  untagged?: boolean;
  onDeleteTag: (tag: string) => void;
  onRenameTag: (from: string, to: string) => void;
  onTagChange: (tag?: string) => void;
  onUntaggedChange: (untagged: boolean) => void;
  /** Jump the timeline to a heatmap day (mini strip + stats). */
  onDaySelect?: (date: string) => void;
  onNavigate?: () => void;
};

export const FlareMoExplorer = memo(function FlareMoExplorer({
  activeTag,
  footer,
  header,
  headerAction,
  hierarchy,
  hierarchyPending = false,
  stats,
  timeZone,
  space,
  untagged = false,
  onDeleteTag,
  onRenameTag,
  onTagChange,
  onUntaggedChange,
  onDaySelect,
  onNavigate,
}: FlareMoExplorerProps) {
  const { t } = useI18n();
  const session = authClient.useSession();
  const captureStatus = useQuery({
    queryKey: queryKeys.captureStatus.forUser(session.data?.user.id),
    queryFn: getCaptureStatus,
    enabled: Boolean(session.data?.user),
    staleTime: 30_000,
    retry: false,
  });
  const streak = useMemo(() => currentStreak(stats.activity), [stats.activity]);

  const [hoveredDate, setHoveredDate] = useState<string | null>(null);

  return (
    <aside className="flex min-h-full flex-col px-3 py-4 text-sm">
      <header className="mb-5 flex items-center justify-between gap-2 px-1">
        {header}
        {headerAction}
      </header>

      <section className="mb-3 px-1 motion-safe:animate-rise">
        <div className="grid grid-cols-3 divide-x divide-border/60 rounded-xl border border-border/60 bg-muted/20 py-2.5 shadow-2xs">
          <StatCell label={t("explorer.records")} value={stats.counts.total} />
          <StatCell label={t("explorer.tags")} value={stats.tags.length} />
          <StatCell label={t("explorer.streak")} value={streak} />
        </div>
      </section>

      <section className="mb-2 px-1 motion-safe:animate-fade">
        <MiniCalendarReminders />
        <FlareMoTimeHorizon
          hoveredDate={hoveredDate}
          space={space}
          stats={stats}
          timeZone={timeZone}
          streak={streak}
          onDaySelect={onDaySelect}
          onHoverDate={setHoveredDate}
          onNavigate={onNavigate}
        />
      </section>

      <nav
        aria-label={t("sidebar.navigation")}
        className="mt-2 flex flex-col gap-1 border-t border-border/60 pt-2.5"
      >
        <Link
          activeOptions={{ exact: true }}
          activeProps={{
            className: "!bg-accent !text-accent-foreground font-medium",
          }}
          className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5"
          onClick={onNavigate}
          search={{
            ...TIMELINE_SEARCH,
          }}
          to="/"
        >
          <LayoutGridIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("nav.allMemos")}</span>
        </Link>
        <Link
          activeProps={{
            className: "!bg-accent !text-accent-foreground font-medium",
          }}
          className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5"
          onClick={onNavigate}
          to="/review/daily"
        >
          <CalendarDaysIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t("nav.dailyReview")}
          </span>
        </Link>
        <Link
          activeProps={{
            className: "!bg-accent !text-accent-foreground font-medium",
          }}
          className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5"
          onClick={onNavigate}
          to="/review/walk"
        >
          <FootprintsIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("nav.randomWalk")}</span>
        </Link>
        {captureStatus.data?.available && (
          <Link
            activeProps={{
              className: "!bg-accent !text-accent-foreground font-medium",
            }}
            className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5"
            onClick={onNavigate}
            to="/capture"
          >
            <MicIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t("nav.capture")}</span>
          </Link>
        )}
        <Link
          activeProps={{
            className: "!bg-accent !text-accent-foreground font-medium",
          }}
          className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5"
          onClick={onNavigate}
          to="/memory"
        >
          <BrainIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("nav.memory")}</span>
        </Link>
        <Link
          activeProps={{
            className: "!bg-accent !text-accent-foreground font-medium",
          }}
          className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onNavigate}
          to="/team-projects"
        >
          <FolderKanbanIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t("nav.teamProjects")}
          </span>
        </Link>
        <Link
          activeProps={{
            className: "!bg-accent !text-accent-foreground font-medium",
          }}
          className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5"
          onClick={onNavigate}
          to="/projects"
        >
          <FolderKanbanIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("nav.projects")}</span>
        </Link>
        <Link
          activeProps={{
            className: "!bg-accent !text-accent-foreground font-medium",
          }}
          className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5"
          onClick={onNavigate}
          to="/articles"
        >
          <FileTextIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("nav.articles")}</span>
        </Link>
      </nav>

      <section className="mt-5 flex flex-col gap-2 px-1">
        <button
          aria-pressed={untagged}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-left motion-safe:transition-colors motion-safe:duration-150",
            untagged
              ? "bg-brand-100 text-brand-700 dark:bg-brand-400/12 dark:text-brand-200"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          type="button"
          onClick={() => {
            onUntaggedChange(!untagged);
            onNavigate?.();
          }}
        >
          <HashIcon className="size-3.5 shrink-0 opacity-60" />
          <span className="truncate">{t("explorer.untagged")}</span>
        </button>
        {hierarchyPending ? (
          // Loading state, not the empty state: flashing「无标签」before the
          // real tree expands reads as data loss. Hold a few ghost rows.
          <div aria-hidden="true" className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="ml-4 h-5 w-2/5" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : hierarchy.length > 0 ? (
          <TagTree
            activeTag={activeTag}
            nodes={hierarchy}
            onDeleteTag={onDeleteTag}
            onRenameTag={onRenameTag}
            onTagChange={onTagChange}
            onNavigate={onNavigate}
          />
        ) : (
          <div className="text-xs text-muted-foreground">
            {t("explorer.noTags")}
          </div>
        )}
      </section>
      {footer && <div className="mt-auto px-1 pt-5 pb-1">{footer}</div>}
    </aside>
  );
});

type TagTreeProps = {
  activeTag?: string;
  nodes: TagHierarchyNode[];
  onDeleteTag: (tag: string) => void;
  onRenameTag: (from: string, to: string) => void;
  onTagChange: (tag?: string) => void;
  onNavigate?: () => void;
};

const TAG_COLLAPSED_STORAGE_KEY = "flaremo.explorer.collapsedTags";

function readCollapsedTags(): Set<string> {
  try {
    const stored = localStorage.getItem(TAG_COLLAPSED_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return new Set(parsed);
    }
  } catch {
    // Best-effort storage fallback
  }
  return new Set();
}

function TagTree({
  activeTag,
  nodes,
  onDeleteTag,
  onRenameTag,
  onTagChange,
  onNavigate,
}: TagTreeProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedTags);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const toggle = (name: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(
          TAG_COLLAPSED_STORAGE_KEY,
          JSON.stringify(Array.from(next)),
        );
      } catch {
        // Ignore quota/private mode errors
      }
      return next;
    });

  const renderNode = (node: TagHierarchyNode, depth: number) => {
    const name = node.name;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(name);
    const isActive = activeTag === name;
    const label = name.split("/").at(-1) ?? name;

    return (
      <div className="flex flex-col" key={name}>
        <div
          className={cn(
            "group flex items-center gap-1 rounded-md py-0.5 pr-1 text-xs motion-safe:transition-colors motion-safe:duration-150",
            isActive
              ? "bg-brand-100 text-brand-700 dark:bg-brand-400/12 dark:text-brand-200"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          style={{ paddingLeft: `${depth * 0.75}rem` }}
        >
          <button
            aria-label={
              hasChildren
                ? isCollapsed
                  ? t("explorer.expand")
                  : t("explorer.collapse")
                : undefined
            }
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground",
              !hasChildren && "invisible",
            )}
            type="button"
            onClick={() => toggle(name)}
          >
            <ChevronRightIcon
              className={cn(
                "h-3.5 w-3.5 motion-safe:transition-transform motion-safe:duration-150",
                !isCollapsed && "rotate-90",
              )}
            />
          </button>
          <button
            aria-pressed={isActive}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
            type="button"
            onClick={() => {
              onTagChange(isActive ? undefined : name);
              onNavigate?.();
            }}
          >
            <HashIcon className="shrink-0 opacity-50" />
            <span className="truncate">{label}</span>
            {node.count > 1 && (
              <span className="tabular-nums opacity-60">{node.count}</span>
            )}
          </button>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 motion-safe:transition-opacity motion-safe:duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              aria-label={t("explorer.renameTag")}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              title={t("explorer.renameTag")}
              type="button"
              onClick={() => setEditing(name)}
            >
              <PencilIcon className="h-3 w-3" />
            </button>
            <button
              aria-label={t("explorer.deleteTag")}
              className="rounded p-0.5 text-muted-foreground hover:text-destructive"
              title={t("explorer.deleteTag")}
              type="button"
              onClick={() => setDeleteTarget(name)}
            >
              <Trash2Icon className="h-3 w-3" />
            </button>
          </div>
        </div>
        {editing === name && (
          <TagRenameInput
            from={name}
            onCancel={() => setEditing(null)}
            onSave={(to) => {
              onRenameTag(name, to);
              setEditing(null);
            }}
          />
        )}
        {hasChildren && !isCollapsed && (
          <div className="flex flex-col motion-safe:animate-fade">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="flex flex-col gap-0.5">
        {nodes.map((n) => renderNode(n, 0))}
      </div>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("explorer.deleteTag")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("explorer.tagDeleteConfirm", { tag: deleteTarget ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) onDeleteTag(deleteTarget);
              }}
            >
              {t("explorer.deleteTag")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TagRenameInput({
  from,
  onCancel,
  onSave,
}: {
  from: string;
  onCancel: () => void;
  onSave: (to: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(from);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="flex flex-col gap-1 px-1"
      style={{ paddingLeft: "1.5rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        const to = value.trim();
        if (to && to !== from) onSave(to);
        else onCancel();
      }}
    >
      <input
        aria-label={t("explorer.renameTagLabel")}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => setValue(event.target.value)}
        placeholder={t("explorer.renameTagPlaceholder")}
        ref={inputRef}
        value={value}
      />
      <div className="flex gap-1">
        <button
          className="rounded-md bg-primary px-2 py-0.5 text-xs text-primary-foreground hover:opacity-90"
          type="submit"
        >
          {t("common.save")}
        </button>
        <button
          className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
          type="button"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center justify-center px-1 text-center">
      <div className="font-heading text-xl leading-none font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
