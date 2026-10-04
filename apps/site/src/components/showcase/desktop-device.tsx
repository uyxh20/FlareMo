import { Bell, Lock, RefreshCw, Search, Settings } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { ShowcaseContent } from "@/content/showcase-i18n";
import { ShowcaseComposer } from "./composer";
import { BrandMark, DeviceSidebar } from "./device-sidebar";
import type { Memo, ShowcaseMenu, ShowcaseTag, TimeViewTab } from "./fixtures";
import { MemoCardList } from "./memo-card";

type DesktopDeviceProps = {
  showcase: ShowcaseContent;
  totalCount: number;
  tagList: ShowcaseTag[];
  activeMenu: ShowcaseMenu;
  activeTag: string | null;
  timeViewTab: TimeViewTab;
  searchQuery: string;
  filteredMemos: Memo[];
  lastSyncedId: string | null;
  composerValue: string;
  isSyncing: boolean;
  onSelectMenu: (menu: ShowcaseMenu) => void;
  onTimeViewTabChange: (tab: TimeViewTab) => void;
  onToggleTag: (name: string) => void;
  onSearchChange: (value: string) => void;
  onComposerValueChange: Dispatch<SetStateAction<string>>;
  onPublish: () => void;
};

/** 电脑端设备：高对比 MacBook 视窗底座 */
export function DesktopDevice({
  showcase,
  totalCount,
  tagList,
  activeMenu,
  activeTag,
  timeViewTab,
  searchQuery,
  filteredMemos,
  lastSyncedId,
  composerValue,
  isSyncing,
  onSelectMenu,
  onTimeViewTabChange,
  onToggleTag,
  onSearchChange,
  onComposerValueChange,
  onPublish,
}: DesktopDeviceProps) {
  return (
    <div className="relative rounded-2xl border-2 border-zinc-300/90 dark:border-zinc-700/80 bg-paper shadow-[0_20px_50px_-15px_rgba(0,0,0,0.3)] dark:shadow-[0_25px_60px_-15px_rgba(0,0,0,0.85)] ring-1 ring-black/10 dark:ring-white/10 overflow-hidden">
      {/* 桌面端浏览器顶栏 */}
      <div className="flex h-9.5 items-center justify-between border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100/90 dark:bg-zinc-900/90 px-4">
        {/* macOS 三色交通灯按键 */}
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-full bg-[#ff5f56] border border-[#e0443e]/40 shadow-xs" />
          <span className="size-3 rounded-full bg-[#ffbd2e] border border-[#dea123]/40 shadow-xs" />
          <span className="size-3 rounded-full bg-[#27c93f] border border-[#1aab29]/40 shadow-xs" />
        </div>

        {/* 居中真实网址栏 */}
        <div className="flex h-6 w-64 sm:w-80 items-center justify-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700/70 bg-white/90 dark:bg-zinc-800/90 px-3 text-[11px] text-zinc-600 dark:text-zinc-300 shadow-2xs">
          <Lock className="size-3 text-signal" />
          <span className="font-mono tracking-tight">
            https://app.flaremo.app
          </span>
        </div>

        <div className="text-[11px] font-mono text-fog flex items-center gap-1.5">
          <span>Cloudflare Workers</span>
        </div>
      </div>

      {/* 电脑端内部结构：左侧资源管理器 + 右侧时间线 */}
      <div className="grid grid-cols-1 md:grid-cols-[210px_1fr] lg:grid-cols-[220px_1fr] min-h-[580px] bg-paper">
        {/* 左侧边栏 (FlareMo Explorer) */}
        <aside className="border-r border-line/60 bg-surface/40 p-4 space-y-4 hidden md:block select-none overflow-y-auto max-h-[620px] no-scrollbar">
          {/* 边栏顶部 Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BrandMark />
            </div>

            <div className="flex items-center gap-1 text-mist">
              <Bell aria-hidden="true" className="size-3.5 text-mist" />
              <span className="inline-flex items-center gap-0.5 rounded-full bg-soft-surface px-1.5 py-0.5 text-[9px] font-mono border border-line/60">
                <RefreshCw className="size-2 text-signal" />
                v0.20
              </span>
              <Settings aria-hidden="true" className="size-3.5 text-mist" />
            </div>
          </div>

          <DeviceSidebar
            variant="desktop"
            showcase={showcase}
            totalCount={totalCount}
            tagList={tagList}
            activeMenu={activeMenu}
            activeTag={activeTag}
            timeViewTab={timeViewTab}
            onTimeViewTabChange={onTimeViewTabChange}
            onSelectMenu={onSelectMenu}
            onToggleTag={onToggleTag}
          />
        </aside>

        {/* 右侧主工作区 (时间线 + 发送器) */}
        <div className="p-4 sm:p-5 space-y-4 max-h-[620px] overflow-y-auto thin-scrollbar">
          {/* 顶部标题栏与搜索条 */}
          <div className="flex items-center justify-between gap-3 pb-1 border-b border-line/60">
            <div className="flex items-center gap-1.5 text-sm font-bold text-ink">
              <span className="text-fog">/</span>
              <span>{activeTag ? `#${activeTag}` : showcase.ui.timeline}</span>
            </div>

            <div className="relative w-44 sm:w-56">
              <Search className="size-3.5 text-fog absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={showcase.ui.searchPlaceholder}
                className="w-full h-8 pl-8 pr-3 rounded-full border border-line/70 bg-surface text-xs text-ink placeholder:text-fog focus:outline-none focus:border-signal/70 transition-colors"
              />
            </div>
          </div>

          {/* 真实桌面端 Composer 发送器 */}
          <ShowcaseComposer
            variant="desktop"
            value={composerValue}
            onValueChange={onComposerValueChange}
            onSubmit={onPublish}
            isSyncing={isSyncing}
            placeholder={showcase.ui.composerPlaceholder}
            sendLabel={showcase.ui.send}
          />

          {/* 真实笔记卡片流 (MemoCard List) */}
          <MemoCardList
            memos={filteredMemos}
            variant="desktop"
            lastSyncedId={lastSyncedId}
            recordPrefix={showcase.ui.recordPrefix}
          />
        </div>
      </div>
    </div>
  );
}
