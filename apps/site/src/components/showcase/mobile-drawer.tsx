import { Settings, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ShowcaseContent } from "@/content/showcase-i18n";
import { BrandMark, DeviceSidebar } from "./device-sidebar";
import type { ShowcaseMenu, ShowcaseTag } from "./fixtures";

type MobileDrawerProps = {
  open: boolean;
  showcase: ShowcaseContent;
  totalCount: number;
  tagList: ShowcaseTag[];
  activeMenu: ShowcaseMenu;
  activeTag: string | null;
  onSelectMenu: (menu: ShowcaseMenu) => void;
  onToggleTag: (name: string) => void;
  onClose: () => void;
};

/** 移动端侧边抽屉：遮罩 + 从左侧滑入的导航面板 */
export function MobileDrawer({
  open,
  showcase,
  totalCount,
  tagList,
  activeMenu,
  activeTag,
  onSelectMenu,
  onToggleTag,
  onClose,
}: MobileDrawerProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 z-40 bg-black/60 backdrop-blur-xs cursor-pointer"
          />

          <motion.aside
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", damping: 26, stiffness: 300 }}
            className="absolute inset-y-0 left-0 z-50 w-[84%] bg-surface border-r border-line shadow-2xl flex flex-col overflow-hidden"
          >
            {/* 抽屉顶部 Header */}
            <div className="p-3.5 border-b border-line/60 flex items-center justify-between bg-surface/90">
              <div className="flex items-center gap-2">
                <BrandMark />
                <span className="inline-flex items-center gap-0.5 rounded-full bg-soft-surface px-1.5 py-0.5 text-[8px] font-mono border border-line/60 text-mist">
                  v0.20
                </span>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1 text-mist hover:text-ink rounded-lg transition-colors cursor-pointer"
                aria-label="关闭侧边栏"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* 抽屉滚动内容 */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3.5 no-scrollbar text-xs">
              <DeviceSidebar
                variant="drawer"
                showcase={showcase}
                totalCount={totalCount}
                tagList={tagList}
                activeMenu={activeMenu}
                activeTag={activeTag}
                onSelectMenu={onSelectMenu}
                onToggleTag={onToggleTag}
                onClose={onClose}
              />
            </div>

            {/* 抽屉底部设置 */}
            <div className="p-2.5 border-t border-line/60 bg-soft-surface/50 flex items-center justify-between text-xs text-mist">
              <div className="flex items-center gap-1.5">
                <span className="size-4 rounded-full bg-signal/20 flex items-center justify-center text-[10px] font-bold text-signal-ink">
                  K
                </span>
                <span className="text-[11px] font-medium text-ink">
                  flaremo-user
                </span>
              </div>
              <Settings aria-hidden="true" className="size-3.5 text-mist" />
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
