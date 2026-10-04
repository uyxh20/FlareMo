import { useNavigate } from "@tanstack/react-router";
import {
  DownloadIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type {
  CurrentFlareMoUser,
  MemoSpace,
  MemoStatsResponse,
  TagHierarchyNode,
} from "@/api";
import { FlareMoExplorer } from "@/components/flaremo-explorer";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { UserMenu } from "@/components/user-menu";
import { useI18n } from "@/i18n";
import { dayFilterQuery } from "@/lib/calendar-date";
import { cn } from "@/lib/utils";

/** Everything the explorer sidebar renders, shared by both drawers. */
export type WorkspaceSidebarContent = {
  activeTag?: string;
  hierarchy: TagHierarchyNode[];
  hierarchyPending: boolean;
  stats: MemoStatsResponse;
  /** Viewer's IANA zone + space scope: the year view anchors its own stats
   * query with them (issue #144). */
  timeZone: string;
  space?: MemoSpace;
  untagged: boolean;
  user: CurrentFlareMoUser | undefined;
  onDeleteTag: (tag: string) => void;
  onExport: () => Promise<void>;
  onImportFile: (bundle: unknown) => Promise<void>;
  onOpenSettings: () => void;
  onRenameTag: (from: string, to: string) => void;
  onTagChange: (tag?: string) => void;
  onToggleCollapsed: () => void;
  onUntaggedChange: (untagged: boolean) => void;
};

type WorkspaceExplorerPanelProps = WorkspaceSidebarContent & {
  /** Id of this instance's hidden import input (desktop and sheet differ). */
  importInputId: string;
  onNavigate?: () => void;
  showCollapse?: boolean;
};

/**
 * One mounted explorer sidebar. Desktop and mobile each render their own, as
 * the single `renderExplorer` helper did before the split.
 */
function WorkspaceExplorerPanel({
  activeTag,
  hierarchy,
  hierarchyPending,
  importInputId,
  onDeleteTag,
  onExport,
  onImportFile,
  onNavigate,
  onOpenSettings,
  onRenameTag,
  onTagChange,
  onToggleCollapsed,
  onUntaggedChange,
  showCollapse = false,
  space,
  stats,
  timeZone,
  untagged,
  user,
}: WorkspaceExplorerPanelProps) {
  const { t } = useI18n();
  const navigate = useNavigate({ from: "/" });

  // FlareMoExplorer is memoized but its slots are ReactNodes, so identity is
  // the only thing that matters: rebuilding them inline on every parent render
  // (the timeline shell re-renders on scroll, collapse, dialogs…) would re-run
  // the explorer's heatmap for nothing. Each slot and callback below is keyed
  // to exactly what it reads.
  const handleOpenSettings = useCallback(() => {
    onNavigate?.();
    onOpenSettings();
  }, [onNavigate, onOpenSettings]);

  const handleDaySelect = useCallback(
    (date: string) => {
      void navigate({
        replace: true,
        search: (current) => ({
          ...current,
          q: dayFilterQuery(date),
          tag: undefined,
          untagged: undefined,
          view: "all",
        }),
      });
    },
    [navigate],
  );

  const header = useMemo(
    () => <UserMenu onOpenSettings={handleOpenSettings} user={user} />,
    [handleOpenSettings, user],
  );

  const headerAction = useMemo(
    () =>
      showCollapse ? (
        <Button
          aria-label={t("sidebar.collapse")}
          size="icon-sm"
          title={t("sidebar.collapse")}
          variant="ghost"
          onClick={onToggleCollapsed}
        >
          <PanelLeftCloseIcon />
        </Button>
      ) : undefined,
    [showCollapse, onToggleCollapsed, t],
  );

  const footer = useMemo(
    () => (
      <div className="flex items-center gap-1 text-muted-foreground">
        <LocaleSwitcher />
        <Button
          aria-label={t("common.export")}
          size="icon-sm"
          title={t("common.export")}
          variant="ghost"
          onClick={() => void onExport()}
        >
          <DownloadIcon />
        </Button>
        <Button
          render={
            <label
              aria-label={t("common.import")}
              htmlFor={importInputId}
              title={t("common.import")}
            />
          }
          size="icon-sm"
          variant="ghost"
        >
          <UploadIcon />
          <Input
            accept="application/json"
            className="hidden"
            id={importInputId}
            type="file"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                const text = await file.text();
                void onImportFile(JSON.parse(text) as unknown);
              } catch {
                toast.error(t("toast.invalidImport"));
              }
            }}
          />
        </Button>
      </div>
    ),
    [importInputId, onExport, onImportFile, t],
  );

  return (
    <FlareMoExplorer
      activeTag={activeTag}
      header={header}
      headerAction={headerAction}
      footer={footer}
      space={space}
      stats={stats}
      timeZone={timeZone}
      hierarchy={hierarchy}
      hierarchyPending={hierarchyPending}
      untagged={untagged}
      onDeleteTag={onDeleteTag}
      onRenameTag={onRenameTag}
      onTagChange={onTagChange}
      onUntaggedChange={onUntaggedChange}
      onDaySelect={handleDaySelect}
      onNavigate={onNavigate}
    />
  );
}

/** The desktop sidebar column, collapsing to zero width with the header button. */
export function WorkspaceSidebar({
  collapsed,
  explorer,
}: {
  collapsed: boolean;
  explorer: WorkspaceSidebarContent;
}) {
  return (
    <aside
      aria-hidden={collapsed}
      className={cn(
        "hidden lg:block h-full shrink-0 overflow-hidden motion-safe:transition-[width,opacity] motion-safe:duration-250 motion-safe:ease-signal",
        collapsed
          ? "w-0 opacity-0 pointer-events-none"
          : "w-[312px] opacity-100",
      )}
    >
      <div className="no-scrollbar h-full w-[312px] overflow-y-auto border-r bg-background">
        <WorkspaceExplorerPanel
          {...explorer}
          importInputId="flaremo-import-file-desktop"
          showCollapse
        />
      </div>
    </aside>
  );
}

/** The mobile drawer: its trigger sits in the header, its panel in the sheet. */
export function WorkspaceMobileSidebar({
  explorer,
  open,
  onOpenChange,
}: {
  explorer: WorkspaceSidebarContent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger
        render={
          <Button
            aria-label={t("sidebar.toggle")}
            className="lg:hidden"
            size="icon-sm"
            variant="ghost"
          >
            <MenuIcon />
          </Button>
        }
      />
      <SheetContent className="w-[312px] overflow-hidden p-0" side="left">
        <SheetTitle className="sr-only">{t("sidebar.title")}</SheetTitle>
        <div
          className="no-scrollbar h-full overflow-y-auto overscroll-contain"
          data-testid="mobile-sidebar-scroll"
        >
          <WorkspaceExplorerPanel
            {...explorer}
            importInputId="flaremo-import-file-mobile"
            onNavigate={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
