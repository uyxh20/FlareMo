import { useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  PaperclipIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  type Attachment,
  bindMemoAttachments,
  type Memo,
  uploadAttachment,
} from "@/api";
import { Button } from "@/components/ui/button";
import { filterUnreferencedAttachments } from "@/lib/attachment-refs";
import { extractTags } from "@/lib/memo";
import { cn } from "@/lib/utils";
import { ForkDropOverlay, useForkFileDrop } from "./file-drop";
import { forkWithUploadRetry } from "./memo-upload-retry";

// The note card's edit mode, made whole (fork-owned, docs/fork-customizations.md
// "Memo editing: files, hidden tags, failed uploads"). memo-card.tsx and
// memo-card-editor.tsx each carry a few marked lines that call in here.
//
// 1. Hidden tags. Most notes (the vault import, reviews, agent drafts) keep
//    their tags in the note's tag list, not in its text. The card shows them
//    in a footer, but edit mode only edits text, and saving re-reads the tags
//    from the text, so one Save silently deleted them. Edit now starts with
//    those tags written as the last line, where they can be changed like any
//    other text, and Save keeps whatever that line says.
// 2. Files in edit mode. The card's files show as chips: × marks one to
//    remove, "Add file" picks (or a drop adds) new ones. Nothing is sent until
//    Save; Cancel leaves the note exactly as it was.

/** Tags on the note that its text does not spell out. */
export function forkTagsOutsideText(memo: Pick<Memo, "content" | "payload">) {
  const inText = new Set(extractTags(memo.content));
  return (memo.payload.tags ?? []).filter(
    (tag) => !inText.has(tag.toLocaleLowerCase()),
  );
}

/**
 * The text edit mode starts from: the note's text, plus its hidden tags as a
 * last line. Only tags that read back as themselves are written, so the line
 * never invents a different tag.
 */
export function forkEditDraftContent(
  memo: Pick<Memo, "content" | "payload">,
): string {
  const tags = forkTagsOutsideText(memo).filter((tag) => {
    const read = extractTags(`#${tag}`);
    return read.length === 1 && read[0] === tag.toLocaleLowerCase();
  });
  if (tags.length === 0) return memo.content;
  const line = tags.map((tag) => `#${tag}`).join(" ");
  const body = memo.content.replace(/\s+$/, "");
  return body ? `${body}\n\n${line}` : line;
}

// Tag edits on the draft text. A tag is `#name` after line start or a
// non-tag character (the shared parser's rule), matched whole and without
// regard to case, so `#ai` never touches `#aim` or `#ai/tools`.
const TAG_CHAR = "[\\p{L}\\p{N}_\\-/]";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagRegExp(tag: string, trailingSpace = false) {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_\\-/])#${escapeRegExp(tag)}(?!${TAG_CHAR})${trailingSpace ? "[ \\t]*" : ""}`,
    "gimu",
  );
}

function tidy(content: string) {
  return content
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}

/** Normalizes what someone typed as a tag name; undefined if it isn't one. */
export function forkCleanTagName(value: string): string | undefined {
  const raw = value.trim().replace(/^#+/, "");
  const read = extractTags(`#${raw}`);
  return read.length === 1 && read[0] === raw.toLocaleLowerCase()
    ? read[0]
    : undefined;
}

/** Removes every `#tag` from the text. */
export function forkRemoveTag(content: string, tag: string): string {
  return tidy(content.replace(tagRegExp(tag, true), "$1"));
}

/** Renames every `#from` to `#to` in the text. */
export function forkRenameTag(
  content: string,
  from: string,
  to: string,
): string {
  const next = forkCleanTagName(to);
  if (!next) return content;
  return content.replace(tagRegExp(from), (_match, lead: string) => {
    return `${lead}#${next}`;
  });
}

/** Adds `#tag` to the last line when that line is only tags, else a new one. */
export function forkAddTag(content: string, tag: string): string {
  const next = forkCleanTagName(tag);
  if (!next || extractTags(content).includes(next)) return content;
  const body = content.replace(/\s+$/, "");
  const lines = body.split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (last.trim() && /^(\s*#[^\s#]+)+\s*$/u.test(last)) {
    lines[lines.length - 1] = `${last.trimEnd()} #${next}`;
    return lines.join("\n");
  }
  return body ? `${body}\n\n#${next}` : `#${next}`;
}

export type ForkEditFiles = {
  /** Files picked in this edit, sent on Save. */
  added: File[];
  /** Names of the note's files marked for removal on Save. */
  removed: ReadonlySet<string>;
  busy: boolean;
  add: (files: File[]) => void;
  drop: (file: File) => void;
  toggleRemoved: (name: string) => void;
  reset: () => void;
  /**
   * Sends the file changes. Resolves false when a file did not upload: the
   * ones that did are kept, the rest stay listed for the next Save.
   */
  apply: () => Promise<boolean>;
};

export function useForkEditFiles(
  memo: Pick<Memo, "name">,
  attachments: Attachment[],
): ForkEditFiles {
  const queryClient = useQueryClient();
  const [added, setAdded] = useState<File[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setAdded([]);
    setRemoved(new Set());
  };

  const apply = async () => {
    if (added.length === 0 && removed.size === 0) return true;
    setBusy(true);
    let changed = false;
    try {
      if (removed.size > 0) {
        // The bind call replaces the note's whole list: keep everything not
        // marked, including images the text shows inline.
        await bindMemoAttachments(
          memo.name,
          attachments
            .filter((item) => !removed.has(item.name))
            .map((item) => item.name),
        );
        changed = true;
        setRemoved(new Set());
      }
      for (const [index, file] of added.entries()) {
        try {
          await forkWithUploadRetry(() =>
            uploadAttachment({ file, memo: memo.name }),
          );
          changed = true;
        } catch {
          setAdded(added.slice(index));
          toast.error(`${file.name} didn't upload. Press Save to try again.`);
          return false;
        }
      }
      setAdded([]);
      return true;
    } catch {
      toast.error("Couldn't update the note's files. Press Save to try again.");
      return false;
    } finally {
      setBusy(false);
      if (changed) {
        void queryClient.invalidateQueries({ queryKey: ["memos"] });
        void queryClient.invalidateQueries({ queryKey: ["memo-context"] });
      }
    }
  };

  return {
    added,
    removed,
    busy,
    add: (files) => setAdded((current) => [...current, ...files]),
    drop: (file) =>
      setAdded((current) => current.filter((item) => item !== file)),
    toggleRemoved: (name) =>
      setRemoved((current) => {
        const next = new Set(current);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      }),
    reset,
    apply,
  };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The chips row under the edit box: the note's files, then new ones. */
export function ForkEditFileChips({
  files,
  attachments,
  content,
  disabled,
}: {
  files: ForkEditFiles;
  attachments: Attachment[];
  /** The draft text: images it shows inline are edited there, not here. */
  content: string;
  disabled: boolean;
}) {
  const existing = filterUnreferencedAttachments(attachments, content);
  if (existing.length === 0 && files.added.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="fork-edit-files">
      {existing.map((item) => {
        const gone = files.removed.has(item.name);
        return (
          <div
            className={cn(
              "flex max-w-full items-center gap-2 rounded-md border border-border/70 bg-background px-2 py-1 text-xs",
              gone && "opacity-50 line-through",
            )}
            key={item.name}
          >
            <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{item.filename}</span>
            <span className="shrink-0 text-muted-foreground">
              {gone ? "removed on Save" : formatSize(item.size)}
            </span>
            <Button
              aria-label={
                gone ? `Keep ${item.filename}` : `Remove ${item.filename}`
              }
              disabled={disabled}
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={() => files.toggleRemoved(item.name)}
            >
              {gone ? <RotateCcwIcon /> : <XIcon />}
            </Button>
          </div>
        );
      })}
      {files.added.map((file, index) => (
        <div
          className="flex max-w-full items-center gap-2 rounded-md border border-dashed border-brand-500/70 bg-background px-2 py-1 text-xs"
          // biome-ignore lint/suspicious/noArrayIndexKey: picked files have no id; order is stable within one edit
          key={`${file.name}-${index}`}
        >
          <PaperclipIcon className="size-3.5 shrink-0 text-brand-600" />
          <span className="truncate">{file.name}</span>
          <span className="shrink-0 text-muted-foreground">
            uploads on Save
          </span>
          <Button
            aria-label={`Don't add ${file.name}`}
            disabled={disabled}
            size="icon-xs"
            type="button"
            variant="ghost"
            onClick={() => files.drop(file)}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}

/** "Add file" for the edit footer. */
export function ForkEditAddFileButton({
  files,
  disabled,
}: {
  files: ForkEditFiles;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        disabled={disabled}
        size="sm"
        type="button"
        variant="ghost"
        className="-ms-2 text-muted-foreground"
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon data-icon="inline-start" />
        Add file
      </Button>
      <input
        aria-label="Add file to this note"
        className="hidden"
        data-testid="fork-edit-file-input"
        multiple
        ref={inputRef}
        type="file"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length > 0) files.add(picked);
        }}
      />
    </>
  );
}

/** Drop files onto the edit box to add them (images still go inline). */
export function useForkEditDrop(
  files: ForkEditFiles | undefined,
  enabled: boolean,
) {
  const drop = useForkFileDrop((picked) => files?.add(picked), enabled);
  return {
    props: drop.props,
    overlay: (
      <ForkDropOverlay label="Drop to add to the note" show={drop.over} />
    ),
  };
}

/**
 * The draft's tags as chips, for reviewing and editing them by hand: click a
 * chip to rename it, × removes it, "Tag" adds one. Every action edits the
 * draft text, so the editor and the chips never disagree.
 */
export function ForkEditTagChips({
  content,
  onChange,
  disabled,
}: {
  content: string;
  onChange: (content: string) => void;
  disabled: boolean;
}) {
  const tags = extractTags(content);
  // The tag being renamed, or "" for a new one; null when none is open.
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");

  const open = (tag: string) => {
    setEditing(tag);
    setValue(tag);
  };
  const close = () => setEditing(null);
  const commit = () => {
    if (editing === null) return;
    const name = forkCleanTagName(value);
    if (!name) {
      if (value.trim()) toast.error("A tag is letters, numbers, - _ and /.");
      else close();
      return;
    }
    if (editing === "") onChange(forkAddTag(content, name));
    else if (name !== editing) onChange(forkRenameTag(content, editing, name));
    close();
  };

  const input = (
    <span className="flex items-center gap-1 rounded-md border border-ring/60 bg-background ps-1.5 text-xs">
      <span className="text-muted-foreground">#</span>
      <input
        // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
        autoFocus
        aria-label={editing ? `Rename #${editing}` : "New tag"}
        className="w-28 bg-transparent py-1 outline-none"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />
      <Button
        aria-label="Apply"
        size="icon-xs"
        type="button"
        variant="ghost"
        onMouseDown={(event) => event.preventDefault()}
        onClick={commit}
      >
        <CheckIcon />
      </Button>
    </span>
  );

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="fork-edit-tags"
    >
      {tags.map((tag) =>
        editing === tag ? (
          <span key={tag}>{input}</span>
        ) : (
          <span
            className="flex items-center rounded-md bg-brand-500/10 text-xs font-medium text-brand-600 dark:text-brand-300"
            key={tag}
          >
            <button
              aria-label={`Rename #${tag}`}
              className="py-1 ps-2 pe-1 hover:underline disabled:opacity-50"
              disabled={disabled}
              title="Click to rename"
              type="button"
              onClick={() => open(tag)}
            >
              #{tag}
            </button>
            <Button
              aria-label={`Remove #${tag}`}
              disabled={disabled}
              size="icon-xs"
              type="button"
              variant="ghost"
              className="text-brand-600 dark:text-brand-300"
              onClick={() => onChange(forkRemoveTag(content, tag))}
            >
              <XIcon />
            </Button>
          </span>
        ),
      )}
      {editing === "" ? (
        input
      ) : (
        <Button
          disabled={disabled}
          size="xs"
          type="button"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => open("")}
        >
          <PlusIcon data-icon="inline-start" />
          Tag
        </Button>
      )}
    </div>
  );
}
