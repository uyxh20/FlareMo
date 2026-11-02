import { plannerAttachmentReadMax } from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import type { PlannerTaskAttachmentRow } from "@flaremo/db/src/schema/planner";
import {
  plannerAgentAddAction,
  plannerAgentSettleAction,
  plannerAttachmentReadKind,
  plannerCutComment,
  plannerEmailToText,
  plannerSetAttachmentReadState,
} from "@flaremo/domain/src/planner";
import type { Context } from "hono";
import type { HonoBindings } from "../context";
import type { FlareMoEnv } from "../env";

// Reading a file on a task into a proposed comment (fork-owned add-on,
// docs/fork-task-attachments.md, phase 2). After a file is stored, or when the
// owner presses "Read again", the Worker reads it once and files the text as a
// `comment_new` proposal, which shows as a card under the file; Accept is what
// writes the comment. Plain text and emails are read here without a model.
// Pictures and PDFs go to Claude's Messages API once, with the same key the
// agent uses, for a faithful transcription: what the file says, never advice.
// Anything else is stored and marked unreadable.
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

const SYSTEM = `You transcribe one file the owner put on a task in their own diary app, so its contents sit on the task as a comment. Write what the file says, faithfully and in full, in plain text: the text on a screenshot or in a document, in reading order; for a picture with little or no text, what it shows in a few plain sentences. Keep names, numbers, dates and amounts exactly. Flatten tables to one line per row. No introduction, no commentary, no advice, no headings of your own, nothing about what you cannot do. Stay under ${plannerAttachmentReadMax} characters: if the file is longer, keep the first part and end with "[cut]".`;

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

/** One Messages API call with the file as an image or a document block. */
async function transcribe(
  env: FlareMoEnv,
  kind: "image" | "pdf",
  bytes: ArrayBuffer,
  contentType: string,
): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("no key");
  const model =
    env.FLAREMO_ATTACHMENT_MODEL?.trim() || FORK_ATTACHMENT_READ_MODEL;
  const source = {
    type: "base64",
    media_type: contentType,
    data: base64(bytes),
  };
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            kind === "image"
              ? { type: "image", source }
              : { type: "document", source },
            { type: "text", text: "Transcribe this file." },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`anthropic ${response.status}`);
  }
  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (body.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
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
    const object = await env.ATTACHMENTS.get(row.r2Key);
    if (!object) return await settle("failed");
    const bytes = await object.arrayBuffer();
    let text: string;
    if (kind === "text") {
      text = new TextDecoder().decode(bytes);
    } else if (kind === "email") {
      text = plannerEmailToText(new TextDecoder().decode(bytes));
    } else {
      text = await transcribe(
        env,
        kind,
        bytes,
        kind === "pdf" ? "application/pdf" : (row.contentType ?? "image/png"),
      );
    }
    const body = plannerCutComment(text);
    if (!body) return await settle("failed");

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
        change: { body, attachment_id: row.id, filename: row.filename },
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
