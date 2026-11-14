import type { Editor } from "@tiptap/react";
import type { RefObject } from "react";
import { inlineImageMarkdown } from "@/lib/image-insert";

/**
 * The upload-placeholder helpers import the ProseMirror plugin runtime
 * (`@tiptap/pm/state` + `/view`). Load them lazily: this pipeline only runs
 * once a TipTap editor is already on screen (its async chunk is live), so the
 * import resolves from cache — while the eager app shell stays free of
 * prosemirror.
 */
async function loadUploadPlaceholderModule() {
  return import("@/components/upload-placeholder-extension");
}

type UploadedAttachment = { id: string; filename: string; name: string };

export type UploadAndInsertOptions = {
  editorRef: RefObject<Editor | null>;
  files: File[];
  /** Document position captured when the paste/drop happened. */
  position: number;
  /** Upload call; the composer uploads unbound, the card binds to the memo. */
  upload: (file: File) => Promise<UploadedAttachment>;
  /** Called per settled file so callers can keep their own bookkeeping. */
  onUploaded?: (attachment: UploadedAttachment, markdown: string) => void;
  /** User-facing failure; stops the remaining files. */
  onError: () => void;
};

/**
 * Shared paste/drop image pipeline for the composer and the card editor. Each
 * file immediately shows an inline "uploading…" chip at the recorded position
 * (mapped through later edits); a settled upload swaps the chip for the real
 * reference in place, and a failure removes it. The document model never
 * contains an upload in flight, so markdown stays clean.
 */
export async function uploadAndInsertImages(
  options: UploadAndInsertOptions,
): Promise<void> {
  const { editorRef, files, position, upload, onUploaded, onError } = options;
  const editor = editorRef.current;
  if (!editor || files.length === 0) return;

  const {
    addUploadPlaceholder,
    findUploadPlaceholder,
    removeUploadPlaceholder,
  } = await loadUploadPlaceholderModule();

  const placeholders = files.map((file, index) => ({
    file,
    id: addUploadPlaceholder(editor, position + index, file.name),
  }));

  for (const placeholder of placeholders) {
    let attachment: UploadedAttachment;
    try {
      attachment = await upload(placeholder.file);
    } catch {
      onError();
      // The failure stops the whole batch: the failing chip and every not-yet-
      // started chip must go, or stale "uploading…" widgets would linger in
      // the editor forever (they also leak into the editor's text content).
      const editorNow = editorRef.current;
      if (editorNow) {
        for (const stale of placeholders) {
          removeUploadPlaceholder(editorNow, stale.id);
        }
      }
      return;
    }
    const editorNow = editorRef.current;
    if (!editorNow) return;
    // Read the chip's mapped position before removing it: the insertion point
    // tracks any edits the user made while the network was pending. A chip
    // that vanished inserts at the document end rather than dropping the image.
    // fork: a vanished chip used to `continue` here, dropping an image that
    // was already uploaded (and, in the composer, never bound to the note).
    const pos =
      findUploadPlaceholder(editorNow, placeholder.id) ??
      editorNow.state.doc.content.size;
    removeUploadPlaceholder(editorNow, placeholder.id);
    const markdown = inlineImageMarkdown(attachment.id, attachment.filename);
    const src = `/file/attachments/${attachment.id}/${encodeURIComponent(attachment.filename)}`;
    // Insert as a JSON image node, not by re-parsing markdown: the markdown
    // path yields a doc-level node and trips the inline-only schema.
    editorNow
      .chain()
      .insertContentAt(Math.min(pos, editorNow.state.doc.content.size), {
        type: "image",
        attrs: { src, alt: attachment.filename.replace(/[[\]]/g, "") },
      })
      .run();
    onUploaded?.(attachment, markdown);
  }
}
