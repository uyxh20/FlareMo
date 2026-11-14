import type { Editor } from "@tiptap/react";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  Suspense,
} from "react";
import { toast } from "sonner";
import { type Attachment, uploadAttachment } from "@/api";
import { RichComposerEditor } from "@/components/rich-composer-editor-lazy";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  ForkEditAddFileButton,
  ForkEditFileChips,
  type ForkEditFiles,
  ForkEditTagChips,
  useForkEditDrop,
} from "@/fork/memo-edit"; // fork: memo editing
import { useI18n } from "@/i18n";
import { uploadAndInsertImages } from "@/lib/rich-editor-upload";

type MemoCardEditorProps = {
  content: string;
  isSaving: boolean;
  isUploadingInline: boolean;
  setIsUploadingInline: Dispatch<SetStateAction<boolean>>;
  /** The live editor handle; the card owns it so an upload outliving the
      editor session keeps its target. */
  editorRef: RefObject<Editor | null>;
  /** Uploads bind to this memo, so a cancelled edit leaves an owned file. */
  memoName: string;
  onCancel: () => void;
  onContentChange: (content: string) => void;
  onSave: () => void;
  /** fork: memo editing — the note's files and this edit's file changes. */
  forkAttachments?: Attachment[];
  forkFiles?: ForkEditFiles;
};

/** The card's edit face: the composer, the inline-upload chips, save/cancel. */
export function MemoCardEditor({
  content,
  isSaving,
  isUploadingInline,
  setIsUploadingInline,
  editorRef,
  memoName,
  onCancel,
  onContentChange,
  onSave,
  forkAttachments = [],
  forkFiles,
}: MemoCardEditorProps) {
  const { t } = useI18n();
  const forkDrop = useForkEditDrop(forkFiles, !isSaving && !!forkFiles); // fork

  // Editing an existing memo: pasted images upload bound to the memo right
  // away, so a cancelled edit leaves nothing to clean up except an
  // unreferenced (but owned) attachment in the gallery. Each file shows an
  // "uploading…" chip until its reference lands at the chip's position.
  const insertInlineImages = (files: File[], position: number) => {
    if (files.length === 0) return;
    setIsUploadingInline(true);
    void uploadAndInsertImages({
      editorRef,
      files,
      position,
      upload: (file) => uploadAttachment({ file, memo: memoName }),
      onError: () => toast.error(t("composer.imageUploadFailed")),
    }).finally(() => setIsUploadingInline(false));
  };

  return (
    <div
      className="relative flex flex-col gap-3 motion-safe:animate-fade"
      {...forkDrop.props}
    >
      {forkDrop.overlay}
      <Suspense fallback={<div className="min-h-7" aria-hidden="true" />}>
        <RichComposerEditor
          ariaLabel={t("common.edit")}
          autoFocus
          content={content}
          disabled={isSaving}
          editorRef={editorRef}
          onContentChange={onContentChange}
          onEscape={onCancel}
          onImageFiles={insertInlineImages}
          inputId="flaremo-card-editor-input"
          contentClassName="composer-editor-content memo-card-editor-content"
          onSubmitRequest={() => {
            if (!isUploadingInline) void onSave();
          }}
          placeholder={t("composer.placeholder")}
        />
      </Suspense>
      {/* fork: memo editing — tags and files, edited by hand */}
      <ForkEditTagChips
        content={content}
        disabled={isSaving}
        onChange={onContentChange}
      />
      {forkFiles && (
        <ForkEditFileChips
          attachments={forkAttachments}
          content={content}
          disabled={isSaving}
          files={forkFiles}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {forkFiles && (
          <ForkEditAddFileButton disabled={isSaving} files={forkFiles} />
        )}
        <span className="hidden sm:inline text-xs text-muted-foreground">
          ⌘Enter / Esc
        </span>
        <div className="flex items-center gap-2 ms-auto">
          <Button
            disabled={isSaving}
            size="sm"
            variant="ghost"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={isSaving || isUploadingInline || !content.trim()}
            size="sm"
            onClick={() => void onSave()}
          >
            {isSaving && <Spinner data-icon="inline-start" />}
            {t("common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
