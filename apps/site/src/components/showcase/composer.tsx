import { Hash, Image as ImageIcon, List, Send } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { ShowcaseDevice } from "./fixtures";

const WRAPPER_CLASS: Record<ShowcaseDevice, string> = {
  desktop:
    "rounded-2xl border border-line/70 bg-surface p-4 shadow-2xs space-y-3",
  mobile:
    "rounded-2xl border border-line/70 bg-surface p-3 shadow-2xs space-y-2",
};

const TEXTAREA_CLASS: Record<ShowcaseDevice, string> = {
  desktop:
    "w-full bg-transparent text-xs sm:text-sm text-ink placeholder:text-fog resize-none focus:outline-none leading-relaxed",
  mobile:
    "w-full bg-transparent text-xs text-ink placeholder:text-fog resize-none focus:outline-none leading-relaxed",
};

const TOOLBAR_CLASS: Record<ShowcaseDevice, string> = {
  desktop: "flex items-center justify-between pt-1 border-t border-line/40",
  mobile: "flex items-center justify-between pt-1",
};

const TOOL_GROUP_CLASS: Record<ShowcaseDevice, string> = {
  desktop: "flex items-center gap-3 text-mist",
  mobile: "flex items-center gap-2.5 text-mist",
};

const TOOL_BUTTON_CLASS: Record<ShowcaseDevice, string> = {
  desktop: "cursor-pointer hover:text-ink transition-colors",
  mobile: "cursor-pointer hover:text-ink",
};

const TOOL_ICON_CLASS: Record<ShowcaseDevice, string> = {
  desktop: "size-4",
  mobile: "size-3.5",
};

const SEND_CLASS: Record<ShowcaseDevice, string> = {
  desktop:
    "inline-flex items-center gap-1.5 rounded-full bg-brand-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:brightness-105 active:translate-y-px transition-all cursor-pointer disabled:opacity-40",
  mobile:
    "inline-flex items-center gap-1 rounded-full bg-brand-gradient px-3 py-1 text-xs font-semibold text-white shadow-xs hover:brightness-105 active:translate-y-px transition-all cursor-pointer disabled:opacity-40",
};

type ShowcaseComposerProps = {
  variant: ShowcaseDevice;
  value: string;
  onValueChange: Dispatch<SetStateAction<string>>;
  onSubmit: () => void;
  isSyncing: boolean;
  placeholder: string;
  sendLabel: string;
};

/** 桌面 / 手机共用的笔记发送器（尺寸与发送中的外观由 variant 决定） */
export function ShowcaseComposer({
  variant,
  value,
  onValueChange,
  onSubmit,
  isSyncing,
  placeholder,
  sendLabel,
}: ShowcaseComposerProps) {
  const isMobile = variant === "mobile";

  return (
    <div className={WRAPPER_CLASS[variant]}>
      <textarea
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        rows={isMobile ? 2 : 3}
        className={TEXTAREA_CLASS[variant]}
      />

      <div className={TOOLBAR_CLASS[variant]}>
        <div className={TOOL_GROUP_CLASS[variant]}>
          <button
            type="button"
            onClick={() => onValueChange((prev) => `${prev} #`)}
            className={TOOL_BUTTON_CLASS[variant]}
            aria-label="插入标签 / Insert tag"
            title={isMobile ? undefined : "插入标签"}
          >
            <Hash className={TOOL_ICON_CLASS[variant]} />
          </button>
          <span aria-hidden="true" className="text-fog opacity-60">
            <ImageIcon className={TOOL_ICON_CLASS[variant]} />
          </span>
          <button
            type="button"
            onClick={() => onValueChange((prev) => `${prev}\n• `)}
            className={TOOL_BUTTON_CLASS[variant]}
            aria-label="插入列表 / Insert list"
            title={isMobile ? undefined : "列表项目"}
          >
            <List className={TOOL_ICON_CLASS[variant]} />
          </button>
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={isSyncing}
          className={SEND_CLASS[variant]}
        >
          {isMobile && isSyncing ? (
            <span className="animate-spin text-xs">⟳</span>
          ) : (
            <>
              <Send className={isMobile ? "size-2.5" : "size-3"} />
              <span>{sendLabel}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
