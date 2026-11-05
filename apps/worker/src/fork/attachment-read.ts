import { Buffer } from "node:buffer";
import {
  plannerAttachmentCopyAudioParts,
  plannerAttachmentCopyAudioSeconds,
  plannerAttachmentReadMax,
  plannerAttachmentSummaryInputMax,
  plannerAttachmentSummaryMax,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import type { PlannerTaskAttachmentRow } from "@flaremo/db/src/schema/planner";
import {
  type PlannerAttachmentReadForm,
  plannerAgentAddAction,
  plannerAgentSettleAction,
  plannerAttachmentCommentHeading,
  plannerAttachmentCopyKey,
  plannerAttachmentNeedsSummary,
  plannerAttachmentReadKind,
  plannerCleanText,
  plannerCutComment,
  plannerEmailToText,
  plannerHtmlToText,
  plannerSetAttachmentReadState,
} from "@flaremo/domain/src/planner";
import type { Context } from "hono";
import type { HonoBindings } from "../context";
import type { FlareMoEnv } from "../env";

// Reading a file on a task into a proposed comment (fork-owned add-on,
// docs/fork-task-attachments.md, phase 2). After a file is stored, or when the
// owner presses "Read again", the Worker reads it once and files the text as a
// `comment_new` proposal, which shows as a card under the file; Accept is what
// writes the comment.
//
// What the comment holds depends on the file's size, not its kind. A short
// file (its text under 5,000 characters: a note, an email, a screenshot of a
// bill) is kept whole, as "Text of <name>". A long one (a web page, a report,
// a long PDF) is summarised by Claude, as "Summary of <name>": what the
// document is, its main points, the names, numbers and dates that matter.
// Plain text, emails and web pages are turned into text here without a model;
// pictures and PDFs go to Claude's Messages API, which reads them whole when
// short and summarises when long. Audio is transcribed by Whisper on Workers
// AI (the AI binding, no key of its own): a short transcript is the comment
// as said, a long one is summarised by Claude. A video is read from its sound
// (transcribed the same way) and up to six still frames, which go to Claude
// together. Both come from the reading copy the browser made beside the file
// (`<file key>~read/…`, contracts `plannerAttachmentCopyParts`), never from the
// file itself, which may be 95 MB; so does an iPhone HEIC photo, whose copy is
// a JPEG. Anything else is stored and marked unreadable.
//
// The read runs after the response (waitUntil), so an upload answers at once
// and the panel asks again every few seconds while the file is `pending`.
// Nothing of the file or the text is logged: only the kind and an error's
// status.

/** The model a transcription goes to; FLAREMO_ATTACHMENT_MODEL overrides it. */
export const FORK_ATTACHMENT_READ_MODEL = "claude-sonnet-5-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const READ_TIMEOUT_MS = 90_000;
/** The answer itself: a whole short file or a summary fits well inside this. */
const READ_MAX_TOKENS = 2_500;
/**
 * Current Claude models think before they answer, and the thinking counts
 * against max_tokens, so the call gets this much room on top of the answer's
 * own (as the review's calls do, planner-review-ai.ts). Without it a long
 * document's summary could stop mid-sentence.
 */
const READ_THINKING_ROOM = 4_000;
/** The Workers AI model a recording is transcribed with. */
export const FORK_ATTACHMENT_TRANSCRIBE_MODEL =
  "@cf/openai/whisper-large-v3-turbo";
/**
 * An audio file with no reading copy (sent by a script, or from a browser
 * that could not decode it) is sent to Whisper as it is, up to this size.
 */
const DIRECT_AUDIO_MAX_BYTES = 20 * 1024 * 1024;

/** The picture types Claude takes as they are. */
const FORK_CLAUDE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** One rule for every read: whole when short, a summary when long. */
const RULES = `Keep names, numbers, dates and amounts exactly. Plain text only: no markdown, no headings of your own, no introduction, no commentary, no advice, nothing about what you cannot do. If what the file says fits in ${plannerAttachmentReadMax} characters, write it in full, faithfully and in reading order (flatten a table to one line per row), and start your answer with the single word "Text" on its own line. If it is longer, write a summary under ${plannerAttachmentSummaryMax} characters instead: first one sentence on what the document is (its kind, subject, date, who it is for), then its main points as short lines, keeping the names, numbers and dates that matter; start your answer with the single word "Summary" on its own line.`;

const FILE_SYSTEM = `You read one file the owner put on a task in their own diary app, so what it says sits on the task as a comment. For a picture with little or no text, say what it shows in a few plain sentences, under "Text". ${RULES}`;

const VIDEO_SYSTEM = `You read one video the owner put on a task in their own diary app, so what is in it sits on the task as a comment. You get up to six still frames taken evenly through it, in order, and a transcript of its sound when there is any. Say what the video shows and what is said in it. Keep names, numbers, dates and amounts exactly. Plain text only: no markdown, no headings of your own, no introduction, no commentary, no advice, nothing about what you cannot do. If it fits in ${plannerAttachmentReadMax} characters, write what happens in a few plain sentences followed by what is said, faithfully, and start your answer with the single word "Text" on its own line. If what is said is longer than that, write a summary under ${plannerAttachmentSummaryMax} characters instead: one sentence on what the video is, then its main points as short lines; start your answer with the single word "Summary" on its own line.`;

const TEXT_SYSTEM = `You summarise one document the owner put on a task in their own diary app, so what it says sits on the task as a comment. You get the document's text; it is longer than a comment should be, so write the summary form. ${RULES}`;

/** Whether this deployment can read files: the agent's key is set. */
export function forkAttachmentReadsEnabled(env: FlareMoEnv): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Runs `work` after the response when the runtime allows it, else awaits it
 * (the tests' harness has no execution context).
 */
export function forkAfterResponse(
  c: Context<HonoBindings>,
  work: Promise<unknown>,
): Promise<void> {
  try {
    c.executionCtx.waitUntil(work);
    return Promise.resolve();
  } catch {
    return work.then(
      () => undefined,
      () => undefined,
    );
  }
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

type Read = { form: PlannerAttachmentReadForm; text: string };

/** Splits the model's answer into its first-line form word and the rest. */
function parseRead(answer: string, fallback: "text" | "summary"): Read {
  const match = /^\s*(Text|Summary)\s*:?\s*\n/i.exec(answer);
  if (!match) return { form: fallback, text: answer.trim() };
  return {
    form: match[1]?.toLowerCase() === "summary" ? "summary" : "text",
    text: answer.slice(match[0].length).trim(),
  };
}

/** One Messages API call; `blocks` is the file as an image or document, or its text. */
async function ask(
  env: FlareMoEnv,
  system: string,
  blocks: Array<Record<string, unknown>>,
  fallback: "text" | "summary",
): Promise<Read> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("no key");
  const model =
    env.FLAREMO_ATTACHMENT_MODEL?.trim() || FORK_ATTACHMENT_READ_MODEL;
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: READ_MAX_TOKENS + READ_THINKING_ROOM,
      system,
      messages: [{ role: "user", content: blocks }],
    }),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`anthropic ${response.status}`);
  }
  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  let answer = (body.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
  // Stopped by the token limit all the same: the last line is unfinished, so
  // it goes, and the comment ends on a whole line rather than mid-sentence.
  if (body.stop_reason === "max_tokens") {
    const lastBreak = answer.trimEnd().lastIndexOf("\n");
    if (lastBreak > 0) answer = answer.slice(0, lastBreak);
  }
  return parseRead(answer, fallback);
}

/** A picture or a PDF, read by Claude: whole when short, a summary when long. */
function readFile(
  env: FlareMoEnv,
  kind: "image" | "pdf",
  bytes: ArrayBuffer,
  contentType: string,
): Promise<Read> {
  const source = {
    type: "base64",
    media_type: contentType,
    data: base64(bytes),
  };
  return ask(
    env,
    FILE_SYSTEM,
    [
      kind === "image"
        ? { type: "image", source }
        : { type: "document", source },
      { type: "text", text: "Read this file." },
    ],
    "text",
  );
}

/** Native base64 (nodejs_compat): a two-minute WAV part is 3.84 MB. */
function base64Fast(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

/** One recording (or one part of it) through Whisper; its words, trimmed. */
async function transcribe(
  env: FlareMoEnv,
  bytes: ArrayBuffer,
): Promise<string> {
  const result = (await env.AI.run(
    FORK_ATTACHMENT_TRANSCRIBE_MODEL as never,
    { audio: base64Fast(bytes) } as never,
  )) as { text?: unknown };
  return typeof result?.text === "string" ? result.text.trim() : "";
}

type Copy = { audio: string[]; frames: string[] };

/** Which parts of a file's reading copy are in the bucket, in reading order. */
async function listCopy(
  env: FlareMoEnv,
  row: PlannerTaskAttachmentRow,
): Promise<Copy> {
  const prefix = plannerAttachmentCopyKey(row.r2Key, "");
  const listed = await env.ATTACHMENTS.list({ prefix, limit: 100 });
  const parts = listed.objects
    .map((object) => object.key.slice(prefix.length))
    .sort();
  return {
    audio: parts.filter((part) => part.endsWith(".wav")),
    frames: parts.filter((part) => part.endsWith(".jpg")),
  };
}

async function getBytes(
  env: FlareMoEnv,
  key: string,
): Promise<ArrayBuffer | null> {
  const object = await env.ATTACHMENTS.get(key);
  return object ? object.arrayBuffer() : null;
}

/**
 * The words of a recording: each two-minute part of the reading copy in turn,
 * or the file itself when it has no copy and is small enough. A copy holds at
 * most 30 minutes; a full one says so at the end.
 */
async function transcribeFile(
  env: FlareMoEnv,
  row: PlannerTaskAttachmentRow,
  copy: Copy,
  allowDirect: boolean,
): Promise<string> {
  if (copy.audio.length === 0) {
    if (!allowDirect || row.size > DIRECT_AUDIO_MAX_BYTES) return "";
    const bytes = await getBytes(env, row.r2Key);
    return bytes ? plannerCleanText(await transcribe(env, bytes)) : "";
  }
  const words: string[] = [];
  for (const part of copy.audio) {
    const bytes = await getBytes(
      env,
      plannerAttachmentCopyKey(row.r2Key, part),
    );
    if (!bytes) continue;
    const text = await transcribe(env, bytes);
    if (text) words.push(text);
  }
  let text = plannerCleanText(words.join(" "));
  if (text && copy.audio.length >= plannerAttachmentCopyAudioParts) {
    const minutes =
      (plannerAttachmentCopyAudioParts * plannerAttachmentCopyAudioSeconds) /
      60;
    text = `${text}\n\n[only the first ${minutes} minutes were transcribed]`;
  }
  return text;
}

/** A recording: its words as said when short, Claude's summary when long. */
async function readAudio(
  env: FlareMoEnv,
  row: PlannerTaskAttachmentRow,
  copy: Copy,
): Promise<Read | null> {
  const text = await transcribeFile(env, row, copy, true);
  if (!text) return null;
  if (!plannerAttachmentNeedsSummary(text)) return { form: "transcript", text };
  return summarise(env, `A transcript of a recording.\n\n${text}`);
}

/** A video: its frames and the words of its sound, read by Claude together. */
async function readVideo(
  env: FlareMoEnv,
  row: PlannerTaskAttachmentRow,
  copy: Copy,
): Promise<Read | null> {
  const transcript = await transcribeFile(env, row, copy, false);
  const frames: Array<Record<string, unknown>> = [];
  for (const part of copy.frames) {
    const bytes = await getBytes(
      env,
      plannerAttachmentCopyKey(row.r2Key, part),
    );
    if (!bytes) continue;
    frames.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: base64Fast(bytes),
      },
    });
  }
  if (frames.length === 0 && !transcript) return null;
  const said = transcript
    ? transcript.length > plannerAttachmentSummaryInputMax
      ? `${transcript.slice(0, plannerAttachmentSummaryInputMax)} [the transcript goes on]`
      : transcript
    : "(no speech in the sound)";
  const read = await ask(
    env,
    VIDEO_SYSTEM,
    [
      ...frames,
      {
        type: "text",
        text: `${frames.length} frames above. The transcript of its sound:\n\n${said}`,
      },
    ],
    "text",
  );
  return read.form === "text" ? { ...read, form: "video" } : read;
}

/** A long text, summarised by Claude. */
function summarise(env: FlareMoEnv, text: string): Promise<Read> {
  const input =
    text.length > plannerAttachmentSummaryInputMax
      ? `${text.slice(0, plannerAttachmentSummaryInputMax)}\n\n[the document goes on; this is the first ${plannerAttachmentSummaryInputMax} characters]`
      : text;
  return ask(
    env,
    TEXT_SYSTEM,
    [{ type: "text", text: `The document:\n\n${input}` }],
    "summary",
  ).then((read) => ({ ...read, form: "summary" }));
}

/**
 * Reads one claimed file (its state is `pending`) and files the proposed
 * comment. Ends with the row in `read`, `failed` or `capped`; never throws.
 * `force` means the owner asked for it again: an earlier open card is put away.
 */
export async function forkReadAttachment(
  env: FlareMoEnv,
  db: FlareMoDb,
  input: { user: UserRow; row: PlannerTaskAttachmentRow; now?: Date },
): Promise<"read" | "failed" | "capped"> {
  const { user, row } = input;
  const settle = async (
    state: "read" | "failed" | "capped",
    actionId?: string,
  ) => {
    await plannerSetAttachmentReadState(db, {
      userId: user.id,
      attachmentId: row.id,
      state,
      ...(actionId ? { actionId } : {}),
    });
    return state;
  };
  const kind = plannerAttachmentReadKind({
    filename: row.filename,
    contentType: row.contentType,
  });
  try {
    if (kind === "other") return await settle("failed");
    let read: Read;
    const copy =
      kind === "audio" || kind === "video" || kind === "image"
        ? await listCopy(env, row)
        : { audio: [], frames: [] };
    if (kind === "audio" || kind === "video") {
      const media =
        kind === "audio"
          ? await readAudio(env, row, copy)
          : await readVideo(env, row, copy);
      if (!media) return await settle("failed");
      read = media;
    } else if (kind === "image" && copy.frames[0]) {
      // The photo's JPEG reading copy: an iPhone HEIC, or one too big for
      // Claude as it is.
      const bytes = await getBytes(
        env,
        plannerAttachmentCopyKey(row.r2Key, copy.frames[0]),
      );
      if (!bytes) return await settle("failed");
      read = await readFile(env, "image", bytes, "image/jpeg");
    } else if (
      kind === "image" &&
      !FORK_CLAUDE_IMAGE_TYPES.has(row.contentType ?? "")
    ) {
      // A HEIC photo with no copy: Claude cannot take it as it is.
      return await settle("failed");
    } else {
      const object = await env.ATTACHMENTS.get(row.r2Key);
      if (!object) return await settle("failed");
      const bytes = await object.arrayBuffer();
      if (kind === "image" || kind === "pdf") {
        read = await readFile(
          env,
          kind,
          bytes,
          kind === "pdf" ? "application/pdf" : (row.contentType ?? "image/png"),
        );
      } else {
        const raw = new TextDecoder().decode(bytes);
        const text = plannerCleanText(
          kind === "email"
            ? plannerEmailToText(raw)
            : kind === "html"
              ? plannerHtmlToText(raw)
              : raw,
        );
        read = plannerAttachmentNeedsSummary(text)
          ? await summarise(env, text)
          : { form: "text", text };
      }
    }
    const content = plannerCutComment(
      read.text,
      read.form === "summary"
        ? plannerAttachmentSummaryMax
        : plannerAttachmentReadMax,
    );
    if (!content) return await settle("failed");
    const body = `${plannerAttachmentCommentHeading(read.form, row.filename)}\n\n${content}`;

    // The owner asked again: the earlier card, if still open, is put away so
    // the file shows one proposal.
    if (row.actionId) {
      await plannerAgentSettleAction(db, {
        userId: user.id,
        id: row.actionId,
        state: "dismissed",
        now: input.now,
      }).catch(() => null);
    }
    try {
      const action = await plannerAgentAddAction(db, {
        userId: user.id,
        runId: null,
        conversationId: null,
        kind: "comment_new",
        taskId: row.taskId,
        field: null,
        change: {
          body,
          attachment_id: row.id,
          filename: row.filename,
          form: read.form,
        },
        why: `Read from ${row.filename}`,
        now: input.now,
      });
      return await settle("read", action.id);
    } catch (error) {
      // The day's 30 proposals are used up: the file says so, and "Read
      // again" tomorrow files it.
      if (error instanceof RangeError) return await settle("capped");
      throw error;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Task file read failed",
        kind,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
    return settle("failed");
  }
}
