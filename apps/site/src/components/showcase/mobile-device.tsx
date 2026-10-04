import { Menu, Search } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { ShowcaseContent } from "@/content/showcase-i18n";
import { ShowcaseComposer } from "./composer";
import type { Memo, ShowcaseMenu, ShowcaseTag } from "./fixtures";
import { MemoCardList } from "./memo-card";
import { MobileDrawer } from "./mobile-drawer";

type MobileDeviceProps = {
  showcase: ShowcaseContent;
  totalCount: number;
  tagList: ShowcaseTag[];
  activeMenu: ShowcaseMenu;
  activeTag: string | null;
  searchQuery: string;
  filteredMemos: Memo[];
  lastSyncedId: string | null;
  composerValue: string;
  isSyncing: boolean;
  drawerOpen: boolean;
  onSelectMenu: (menu: ShowcaseMenu) => void;
  onToggleTag: (name: string) => void;
  onSearchChange: (value: string) => void;
  onComposerValueChange: Dispatch<SetStateAction<string>>;
  onPublish: () => void;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
  onClearTag: () => void;
};

/** 手机端设备：高质感钛金属 / 极夜黑真实手机硬件模型 */
export function MobileDevice({
  showcase,
  totalCount,
  tagList,
  activeMenu,
  activeTag,
  searchQuery,
  filteredMemos,
  lastSyncedId,
  composerValue,
  isSyncing,
  drawerOpen,
  onSelectMenu,
  onToggleTag,
  onSearchChange,
  onComposerValueChange,
  onPublish,
  onOpenDrawer,
  onCloseDrawer,
  onClearTag,
}: MobileDeviceProps) {
  return (
    <div className="relative mx-auto w-full max-w-[320px] rounded-[48px] border-[9px] border-zinc-900 dark:border-zinc-800 bg-zinc-950 p-[2px] shadow-[0_25px_65px_-12px_rgba(0,0,0,0.45)] dark:shadow-[0_30px_80px_-15px_rgba(0,0,0,0.9)] ring-1 ring-zinc-700/80 dark:ring-zinc-600/70 select-none">
      {/* 机身侧键物理凹槽 */}
      <span className="absolute -left-[12px] top-24 h-8 w-1 rounded-l-sm bg-zinc-700 dark:bg-zinc-600" />
      <span className="absolute -left-[12px] top-36 h-8 w-1 rounded-l-sm bg-zinc-700 dark:bg-zinc-600" />
      <span className="absolute -right-[12px] top-28 h-12 w-1 rounded-r-sm bg-zinc-700 dark:bg-zinc-600" />

      {/* 屏幕玻璃与边框 */}
      <div className="overflow-hidden rounded-[38px] bg-paper border border-black/20 dark:border-white/5 flex flex-col h-[560px] relative">
        {/* 手机系统状态栏 + 灵动岛 (Dynamic Island) */}
        <div className="h-10 bg-soft-surface px-6 flex items-center justify-between border-b border-line/60 shrink-0">
          <span className="text-[11px] font-bold text-ink tracking-tight">
            09:41
          </span>
          {/* 灵动岛胶囊孔 */}
          <div className="h-4 w-20 rounded-full bg-black flex items-center justify-center px-2 shadow-inner">
            <span className="size-1.5 rounded-full bg-zinc-900 ring-1 ring-zinc-800" />
          </div>
          <div className="flex items-center gap-1 text-[10px] text-ink font-bold">
            5G
          </div>
        </div>

        {/* 移动端 App 顶栏：汉堡菜单 + 标题 + 筛选提示 */}
        <div className="px-3.5 py-2 border-b border-line/60 bg-surface flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenDrawer}
              className="p-1 -ml-1 text-ink hover:text-signal hover:bg-wash transition-colors cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 focus-visible:ring-offset-1 flex items-center"
              aria-label="导航菜单"
            >
              <Menu className="size-4" />
            </button>
            <span className="text-sm font-bold text-ink tracking-tight">
              {activeTag
                ? `#${activeTag}`
                : activeMenu === "timeline"
                  ? showcase.ui.timeline
                  : activeMenu === "archive"
                    ? showcase.ui.archive
                    : showcase.ui.trash}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {activeTag && (
              <button
                type="button"
                onClick={onClearTag}
                className="text-xs text-mist hover:text-ink cursor-pointer font-medium"
              >
                {showcase.ui.clearFilter}
              </button>
            )}
            <span className="text-[10px] text-fog font-mono bg-soft-surface px-1.5 py-0.5 rounded-full border border-line/60">
              {filteredMemos.length}
            </span>
          </div>
        </div>

        {/* 手机屏幕主内容区 (可滚动，使用 no-scrollbar) */}
        <div className="p-3 flex-1 overflow-y-auto space-y-3 no-scrollbar">
          {/* 搜索框 */}
          <div className="relative">
            <Search className="size-3 text-fog absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={showcase.ui.searchPlaceholder}
              className="w-full h-7 pl-7 pr-3 rounded-full border border-line/70 bg-surface text-xs text-ink placeholder:text-fog focus:outline-none"
            />
          </div>

          {/* 手机端真实 Memo 发送器 */}
          <ShowcaseComposer
            variant="mobile"
            value={composerValue}
            onValueChange={onComposerValueChange}
            onSubmit={onPublish}
            isSyncing={isSyncing}
            placeholder={showcase.ui.composerPlaceholder}
            sendLabel={showcase.ui.send}
          />

          {/* 移动端时间线笔记流 */}
          <MemoCardList
            memos={filteredMemos}
            variant="mobile"
            lastSyncedId={lastSyncedId}
            recordPrefix={showcase.ui.recordPrefix}
          />
        </div>

        {/* 手机底部指示条 (Home Indicator) */}
        <div className="h-5 flex items-center justify-center bg-soft-surface shrink-0 border-t border-line/40 select-none">
          <span className="h-1 w-24 rounded-full bg-mist/50" />
        </div>

        {/* 移动端真实侧边抽屉 (Sheet Drawer) */}
        <MobileDrawer
          open={drawerOpen}
          showcase={showcase}
          totalCount={totalCount}
          tagList={tagList}
          activeMenu={activeMenu}
          activeTag={activeTag}
          onSelectMenu={onSelectMenu}
          onToggleTag={onToggleTag}
          onClose={onCloseDrawer}
        />
      </div>
    </div>
  );
}
