import { toast } from "sonner";
import { ApiError, type Memo, uploadAttachment } from "@/api";

// Note uploads that survive a hiccup (fork-owned, docs/fork-customizations.md
// "Memo editing: files, hidden tags, failed uploads").
//
// Upstream sends the note first and its files after. When a file upload threw
// a browser error (dropped connection, Chrome's "file changed since you picked
// it"), the whole note went to the offline queue: the text was already saved,
// the composer said "You are offline" and cleared, and a later replay bound
// the file to whatever the note had become, even a note in the trash.
//
// Now each upload is retried a couple of times, and a file that still fails
// raises ForkAttachmentUploadError, which carries the saved note so the
// composer can say "Note saved, but … didn't upload" with a Retry.

/** A note was saved but some of its files were not. */
export class ForkAttachmentUploadError extends Error {
  readonly memo: Memo;
  /** The file that failed and every file after it, in order. */
  readonly files: File[];
  readonly cause: unknown;
  /** Stable upload ids per file, so Retry never stores a file twice. */
  readonly clientIds: Array<string | undefined>;

  constructor(
    memo: Memo,
    files: File[],
    cause: unknown,
    clientIds: Array<string | undefined> = [],
  ) {
    super(forkUploadFailedMessage(files));
    this.name = "ForkAttachmentUploadError";
    this.memo = memo;
    this.files = files;
    this.cause = cause;
    this.clientIds = clientIds;
  }
}

export function forkUploadFailedMessage(files: File[]): string {
  const first = files[0]?.name ?? "A file";
  const more = files.length > 1 ? ` and ${files.length - 1} more` : "";
  return `Note saved, but ${first}${more} didn't upload.`;
}

/**
 * A refusal the server meant (too large, wrong type, not allowed) will not
 * change on a second try. A dropped connection, a timeout, a rate limit or a
 * server error might.
 */
export function forkIsRetryableUploadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

const RETRY_DELAYS_MS = [700, 2000];

/** Runs `run`, retrying twice on errors worth retrying. */
export async function forkWithUploadRetry<T>(
  run: () => Promise<T>,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !forkIsRetryableUploadError(error)) {
        throw error;
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** A trashed note takes no new files: its owner deleted it on purpose. */
export function forkMemoTakesFiles(memo: Pick<Memo, "state">): boolean {
  return memo.state !== "trashed";
}

/**
 * "Note saved, but … didn't upload", with a Retry that uploads the remaining
 * files to that same note. `onUploaded` refreshes whatever shows the note.
 */
export function forkShowUploadFailedToast(
  error: ForkAttachmentUploadError,
  onUploaded: () => void,
) {
  toast.error(error.message, {
    duration: 30_000,
    action: {
      label: "Retry",
      onClick: () => void forkRetryUploads(error, onUploaded),
    },
  });
}

async function forkRetryUploads(
  error: ForkAttachmentUploadError,
  onUploaded: () => void,
) {
  for (const [index, file] of error.files.entries()) {
    try {
      await forkWithUploadRetry(() =>
        uploadAttachment({
          file,
          memo: error.memo.name,
          clientId: error.clientIds[index],
        }),
      );
    } catch (cause) {
      if (index > 0) onUploaded();
      forkShowUploadFailedToast(
        new ForkAttachmentUploadError(
          error.memo,
          error.files.slice(index),
          cause,
          error.clientIds.slice(index),
        ),
        onUploaded,
      );
      return;
    }
  }
  onUploaded();
  toast.success(
    error.files.length > 1
      ? "Files added to the note."
      : "File added to the note.",
  );
}
