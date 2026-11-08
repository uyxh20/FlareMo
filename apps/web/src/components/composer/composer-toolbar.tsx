import type { Editor } from "@tiptap/react";
import {
  CalendarPlusIcon,
  CheckSquareIcon,
  HashIcon,
  ImageIcon,
  ListIcon,
  ListOrderedIcon,
  Maximize2Icon,
  MicIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ForkComposerSummarizeButton } from "@/fork/summarize-link"; // fork: link summaries
import { useI18n } from "@/i18n";
import type { MemoCaptureInput } from "@/lib/local-memo-capture";

/**
 * Formatting rail of the composer: tag, attachment picker, the three list
 * toggles, the date stamp, and the voice entry. It is the left half of the
 * composer's bottom bar, rendered next to the visibility menu and the round
 * send button. Every editor action goes through `withEditor`, which no-ops
 * while a submission is pending.
 */
export function ComposerToolbar({
  draft,
  isPending,
  voiceActive,
  captureAvailable,
  withEditor,
  onDraftChange,
  onStartVoice,
  onExpand,
}: {
  draft: MemoCaptureInput;
  isPending: boolean;
  voiceActive: boolean;
  captureAvailable: boolean;
  withEditor: (action: (editor: Editor) => void) => void;
  onDraftChange: (draft: MemoCaptureInput) => void;
  /** Starts a session; the caller owns the controller. */
  onStartVoice: () => void;
  /** Opens fullscreen focus canvas. */
  onExpand?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 items-center gap-0.5 sm:gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden py-0.5">
      <Button
        aria-label={t("composer.addTag")}
        disabled={isPending}
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={() =>
          withEditor((editor) => {
            editor
              .chain()
              .focus()
              .insertContentAt(editor.state.selection.to, "#")
              .run();
          })
        }
      >
        <HashIcon />
      </Button>
      <Button
        render={
          <label
            aria-label={t("composer.addAttachment")}
            htmlFor="flaremo-attachment-input"
          />
        }
        disabled={isPending}
        size="icon-sm"
        variant="ghost"
      >
        <ImageIcon />
        <Input
          className="hidden"
          id="flaremo-attachment-input"
          multiple
          type="file"
          disabled={isPending}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length === 0) return;
            onDraftChange({
              ...draft,
              files: [...draft.files, ...files],
            });
          }}
        />
      </Button>
      <div className="hidden h-4 w-px bg-border sm:block" />
      <Button
        aria-label={t("composer.bulletList")}
        disabled={isPending}
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={() =>
          withEditor((editor) => {
            editor.chain().focus().toggleBulletList().run();
          })
        }
      >
        <ListIcon />
      </Button>
      <Button
        aria-label={t("composer.orderedList")}
        disabled={isPending}
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={() =>
          withEditor((editor) => {
            editor.chain().focus().toggleOrderedList().run();
          })
        }
      >
        <ListOrderedIcon />
      </Button>
      <Button
        aria-label={t("composer.taskList")}
        disabled={isPending}
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={() =>
          withEditor((editor) => {
            editor.chain().focus().toggleTaskList().run();
          })
        }
      >
        <CheckSquareIcon />
      </Button>
      <Button
        aria-label={t("composer.insertDate")}
        disabled={isPending}
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={() =>
          withEditor((editor) => {
            const today = new Date().toISOString().slice(0, 10);
            editor.chain().focus().insertContent(`${today} `).run();
          })
        }
        title={t("composer.insertDate")}
      >
        <CalendarPlusIcon />
      </Button>
      {captureAvailable && (
        <Button
          aria-label={t("composer.voice")}
          className={voiceActive ? "text-brand-600" : undefined}
          disabled={isPending}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={() => {
            if (voiceActive) return;
            onStartVoice();
          }}
        >
          <MicIcon />
        </Button>
      )}
      {onExpand && (
        <Button
          aria-label={t("composer.fullscreen.open")}
          disabled={isPending}
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onExpand}
          onMouseEnter={() => {
            void import(
              "@/components/composer/composer-focus-canvas-lazy"
            ).then((m) => m.loadComposerFocusCanvas());
          }}
          title={t("composer.fullscreen.open")}
        >
          <Maximize2Icon />
        </Button>
      )}
      <ForkComposerSummarizeButton
        content={draft.content}
        disabled={isPending}
      />
    </div>
  );
}
