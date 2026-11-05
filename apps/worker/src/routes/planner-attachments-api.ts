import {
  type PlannerAttachmentListResponse,
  type PlannerAttachmentResponse,
  type PlannerAttachmentSettingsResponse,
  type PlannerChatFileReadResponse,
  type PlannerChatFileResponse,
  type PlannerDeleteAttachmentResponse,
  plannerAttachmentCopyHeader,
  plannerAttachmentCopyPartMaxBytes,
  plannerAttachmentCopyParts,
  plannerAttachmentMaxBytes,
  plannerAttachmentMaxBytesFor,
  plannerAttachmentNameHeader,
  plannerAttachmentSettingsSchema,
  plannerChatFileTextMax,
} from "@flaremo/contracts";
import {
  assertAttachmentStorageQuota,
  DomainError,
  parseResourceName,
} from "@flaremo/domain";
import {
  plannerAddAttachment,
  plannerAssertAttachmentAllowed,
  plannerAssertAttachmentSize,
  plannerAttachmentCopyKey,
  plannerAttachmentCopyKeys,
  plannerClaimAttachmentRead,
  plannerListAttachments,
  plannerLoadAttachment,
  plannerNormalizeAttachmentName,
  plannerReadAttachments,
  plannerRemoveAttachment,
  plannerSetTaskFilesRead,
} from "@flaremo/domain/src/planner";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import {
  forkAfterResponse,
  forkAttachmentReadsEnabled,
  forkReadAttachment,
  forkReadFileText,
} from "../fork/attachment-read";
import {
  FORK_CHAT_FILE_PREFIX,
  forkTaskAttachmentResponse,
} from "../fork/task-attachments";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";
import { plannerResolveActor } from "./planner-route-helpers";

// Files on cockpit tasks (fork-owned add-on, docs/fork-task-attachments.md),
// registered on the planner sub-app like the goals and agent routes, so the
// lazy mount, the auth rules and the JSON 404 cover them too.
//
// An upload is the file itself as the request body, with its MIME type in
// Content-Type and its name, percent-encoded, in `x-planner-filename`: no
// multipart and no base64, so a 10 MB file is 10 MB on the wire. The Worker
// checks the size and the task's room before it reads the body, puts the
// object in the ATTACHMENTS bucket under `planner/`, then records the row; if
// the row fails the object is deleted again, so the bucket never holds a file
// no task knows. The bytes are served back from the same place, behind the
// same login, with upstream's range and ETag handling.
//
// Once stored, a file is read into a proposed comment (fork/attachment-read.ts)
// unless the task is set to store only; the read runs after the response and
// the panel asks again while the file is `pending`. "Read again" claims a new
// read; the settings route keeps the task's switch.

export const plannerAttachmentsApi = new Hono<HonoBindings>();

const parseTaskId = (value: string) => parseResourceName(value, "tasks");

plannerAttachmentsApi.get("/tasks/:id/attachments", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    const response: PlannerAttachmentListResponse = {
      attachments: await plannerListAttachments(db, {
        userId: user.id,
        taskId: parseTaskId(c.req.param("id")),
      }),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

plannerAttachmentsApi.post("/tasks/:id/attachments", async (c) => {
  let objectKey: string | null = null;
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    const taskId = parseTaskId(c.req.param("id"));

    const filename = plannerNormalizeAttachmentName(
      decodeHeaderName(c.req.header(plannerAttachmentNameHeader)),
    );
    const contentType =
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ||
      "application/octet-stream";
    const file = { filename, contentType };

    // The declared size is checked before the body is read, so an oversized
    // upload is refused without buffering it. The real size is checked again.
    // Audio and video may be up to 95 MB, everything else 10 MB.
    const declared = Number(c.req.header("content-length") ?? "NaN");
    const max = plannerAttachmentMaxBytesFor(file);
    if (Number.isFinite(declared) && declared > max) {
      throw new DomainError(
        `${max === plannerAttachmentMaxBytes ? "A file" : "An audio or video file"} can be at most ${max / (1024 * 1024)} MB.`,
        413,
      );
    }
    await plannerAssertAttachmentAllowed(context.db, {
      userId: context.user.id,
      taskId,
      size: Number.isFinite(declared) ? declared : 1,
      ...file,
    });

    objectKey = forkAttachmentObjectKey(context.user.id, filename);
    let size: number;
    let object: R2Object;
    if (
      Number.isFinite(declared) &&
      declared > plannerAttachmentMaxBytes &&
      c.req.raw.body
    ) {
      // A big audio or video file goes straight through to R2 as a stream: a
      // Worker has 128 MB of memory, too little to hold 95 MB and work on it.
      // The stream's length is the declared one; R2 refuses a body that ends
      // short or runs long, and the real size is checked once it is stored.
      await assertAttachmentStorageQuota(context.db, context.limits, declared, {
        userLimits: context.userLimits,
        userId: context.user.id,
      });
      object = await c.env.ATTACHMENTS.put(objectKey, c.req.raw.body, {
        httpMetadata: { contentType },
      });
      size = object.size;
      await plannerAssertAttachmentAllowed(context.db, {
        userId: context.user.id,
        taskId,
        size,
        ...file,
      });
    } else {
      const bytes = await c.req.arrayBuffer();
      await plannerAssertAttachmentAllowed(context.db, {
        userId: context.user.id,
        taskId,
        size: bytes.byteLength,
        ...file,
      });
      await assertAttachmentStorageQuota(
        context.db,
        context.limits,
        bytes.byteLength,
        { userLimits: context.userLimits, userId: context.user.id },
      );
      object = await c.env.ATTACHMENTS.put(objectKey, bytes, {
        httpMetadata: { contentType },
      });
      size = bytes.byteLength;
    }
    let attachment = await plannerAddAttachment(context.db, {
      user: context.user,
      actor: await plannerResolveActor(c, context.credential),
      taskId,
      filename,
      contentType,
      size,
      r2Key: objectKey,
      etag: object.httpEtag,
    });
    objectKey = null;
    // A reading copy follows (audio, video, an iPhone photo): the file stays
    // `stored` until the browser has put the copy's parts and asks for the
    // read. If it never does, the file shows Read like any unread file.
    const copyFollows = c.req.header(plannerAttachmentCopyHeader) === "1";
    if (forkAttachmentReadsEnabled(c.env) && !copyFollows) {
      const claimed = await plannerClaimAttachmentRead(context.db, {
        userId: context.user.id,
        attachmentId: attachment.id,
      });
      if (claimed) {
        await forkAfterResponse(
          c,
          forkReadAttachment(c.env, context.db, {
            user: context.user,
            row: claimed,
          }),
        );
      }
      // The row as it stands now: `pending` while the read runs after the
      // response, `skipped` or `capped` when it was not started.
      attachment =
        (
          await plannerReadAttachments(context.db, {
            userId: context.user.id,
            taskId,
          })
        ).find((entry) => entry.id === attachment.id) ?? attachment;
    }
    const response: PlannerAttachmentResponse = { attachment };
    return c.json(response, 201);
  } catch (error) {
    if (objectKey) {
      await c.env.ATTACHMENTS.delete(objectKey).catch(() => {});
    }
    return jsonError(c, error);
  }
});

plannerAttachmentsApi.get(
  "/tasks/:id/attachments/:attachment/:filename",
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const row = await plannerLoadAttachment(db, {
        userId: user.id,
        attachmentId: c.req.param("attachment"),
      });
      if (row.taskId !== parseTaskId(c.req.param("id"))) {
        return c.json({ error: { message: "File not found" } }, 404);
      }
      const response = await forkTaskAttachmentResponse({
        row,
        bucket: c.env.ATTACHMENTS,
        request: c.req.raw,
      });
      return response ?? c.json({ error: { message: "File not found" } }, 404);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerAttachmentsApi.delete("/attachments/:id", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    await plannerRemoveAttachment(context.db, {
      user: context.user,
      actor: await plannerResolveActor(c, context.credential),
      attachmentId: c.req.param("id"),
    });
    const response: PlannerDeleteAttachmentResponse = { ok: true };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// One part of a file's reading copy (contracts, `plannerAttachmentCopyParts`):
// a two-minute WAV of its sound, or a JPEG still. The browser makes the copy
// from the file it is uploading, because a Worker cannot decode audio or
// video; the parts sit beside the file and are deleted with it.
plannerAttachmentsApi.put("/attachments/:id/copy/:part", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    const part = c.req.param("part");
    if (!plannerAttachmentCopyParts.includes(part)) {
      throw new DomainError("Unknown part of a reading copy.", 400);
    }
    const declared = Number(c.req.header("content-length") ?? "NaN");
    if (
      Number.isFinite(declared) &&
      declared > plannerAttachmentCopyPartMaxBytes
    ) {
      throw new DomainError("This part of the reading copy is too big.", 413);
    }
    const row = await plannerLoadAttachment(context.db, {
      userId: context.user.id,
      attachmentId: c.req.param("id"),
    });
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) {
      throw new DomainError("This part of the reading copy is empty.", 400);
    }
    if (bytes.byteLength > plannerAttachmentCopyPartMaxBytes) {
      throw new DomainError("This part of the reading copy is too big.", 413);
    }
    await c.env.ATTACHMENTS.put(
      plannerAttachmentCopyKey(row.r2Key, part),
      bytes,
      {
        httpMetadata: {
          contentType: part.endsWith(".wav") ? "audio/wav" : "image/jpeg",
        },
      },
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

// "Read again": a file that failed, was capped, was skipped or whose card was
// dismissed is read once more. 409 while a read is already under way.
plannerAttachmentsApi.post("/attachments/:id/read", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    if (!forkAttachmentReadsEnabled(c.env)) {
      throw new DomainError("Reading files is not set up here.", 400);
    }
    const before = await plannerLoadAttachment(context.db, {
      userId: context.user.id,
      attachmentId: c.req.param("id"),
    });
    if (before.readState === "pending") {
      throw new DomainError("This file is being read.", 409);
    }
    // `?first=1` is the browser asking for a file's first read once its
    // reading copy is up: like the read an upload starts, it keeps to the
    // task's "store only" switch. Without it this is the owner's Read again.
    const first = c.req.query("first") === "1";
    const claimed = await plannerClaimAttachmentRead(context.db, {
      userId: context.user.id,
      attachmentId: before.id,
      force: !first,
    });
    if (claimed) {
      await forkAfterResponse(
        c,
        forkReadAttachment(c.env, context.db, {
          user: context.user,
          row: claimed,
        }),
      );
    }
    const [attachment] = (
      await plannerReadAttachments(context.db, {
        userId: context.user.id,
        taskId: before.taskId,
      })
    ).filter((entry) => entry.id === before.id);
    if (!attachment) throw new DomainError("File not found", 404);
    const response: PlannerAttachmentResponse = { attachment };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// --- Files dropped in a chat (docs/fork-task-attachments.md, "Files in Ask
// my diary") ---------------------------------------------------------------
//
// The Ask my diary chat is about no task, so a file dropped there is not kept:
// it is stored only until it is read, under `planner-chat/<user>/<id>/<name>`
// with its reading copy beside it, then the read answers the text and deletes
// all of it. The page sends that text with the next question. What is never
// read is deleted by the nightly sweep a day later.

/** Where a chat file sits: found by its id under the user's own prefix. */
async function chatFileObject(
  bucket: R2Bucket,
  userId: string,
  id: string,
): Promise<R2Object | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const listed = await bucket.list({
    prefix: `${FORK_CHAT_FILE_PREFIX}${userId}/${id}/`,
    limit: 50,
    include: ["customMetadata", "httpMetadata"],
  });
  return (
    listed.objects.find((object) => !object.key.includes("~read/")) ?? null
  );
}

plannerAttachmentsApi.post("/chat-files", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    const filename = plannerNormalizeAttachmentName(
      decodeHeaderName(c.req.header(plannerAttachmentNameHeader)),
    );
    const contentType =
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ||
      "application/octet-stream";
    const declared = Number(c.req.header("content-length") ?? "NaN");
    plannerAssertAttachmentSize(Number.isFinite(declared) ? declared : 1, {
      filename,
      contentType,
    });
    const id = crypto.randomUUID();
    const safe =
      filename.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
    const key = `${FORK_CHAT_FILE_PREFIX}${context.user.id}/${id}/${safe}`;
    const options = {
      httpMetadata: { contentType },
      customMetadata: { filename: encodeURIComponent(filename) },
    };
    // A big recording or video streams to R2, as on a task.
    const object =
      Number.isFinite(declared) &&
      declared > plannerAttachmentMaxBytes &&
      c.req.raw.body
        ? await c.env.ATTACHMENTS.put(key, c.req.raw.body, options)
        : await c.env.ATTACHMENTS.put(key, await c.req.arrayBuffer(), options);
    try {
      plannerAssertAttachmentSize(object.size, { filename, contentType });
    } catch (error) {
      await c.env.ATTACHMENTS.delete(key);
      throw error;
    }
    const response: PlannerChatFileResponse = { file: { id, filename } };
    return c.json(response, 201);
  } catch (error) {
    return jsonError(c, error);
  }
});

plannerAttachmentsApi.put("/chat-files/:id/copy/:part", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    const part = c.req.param("part");
    if (!plannerAttachmentCopyParts.includes(part)) {
      throw new DomainError("Unknown part of a reading copy.", 400);
    }
    const object = await chatFileObject(
      c.env.ATTACHMENTS,
      context.user.id,
      c.req.param("id"),
    );
    if (!object) throw new DomainError("File not found", 404);
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) {
      throw new DomainError("This part of the reading copy is empty.", 400);
    }
    if (bytes.byteLength > plannerAttachmentCopyPartMaxBytes) {
      throw new DomainError("This part of the reading copy is too big.", 413);
    }
    await c.env.ATTACHMENTS.put(
      plannerAttachmentCopyKey(object.key, part),
      bytes,
      {
        httpMetadata: {
          contentType: part.endsWith(".wav") ? "audio/wav" : "image/jpeg",
        },
      },
    );
    return c.json({ ok: true });
  } catch (error) {
    return jsonError(c, error);
  }
});

// Reads a chat file now (the answer waits for it: a recording can take a
// minute) and deletes it with its copy, read or not.
plannerAttachmentsApi.post("/chat-files/:id/read", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner-ai", context.user.id);
    if (throttled) return throttled;
    if (!forkAttachmentReadsEnabled(c.env)) {
      throw new DomainError("Reading files is not set up here.", 400);
    }
    const object = await chatFileObject(
      c.env.ATTACHMENTS,
      context.user.id,
      c.req.param("id"),
    );
    if (!object) throw new DomainError("File not found", 404);
    const filename =
      decodeHeaderName(object.customMetadata?.filename) || "file";
    let text: string | null = null;
    try {
      text =
        (
          await forkReadFileText(c.env, {
            r2Key: object.key,
            filename,
            contentType: object.httpMetadata?.contentType ?? null,
            size: object.size,
          })
        )?.text ?? null;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Chat file read failed",
          error:
            error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }),
      );
    } finally {
      await c.env.ATTACHMENTS.delete([
        object.key,
        ...plannerAttachmentCopyKeys(object.key),
      ]).catch(() => {});
    }
    const response: PlannerChatFileReadResponse = {
      filename,
      text: text ? text.slice(0, plannerChatFileTextMax) : null,
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// The task's "Store only, don't read these files" switch.
plannerAttachmentsApi.patch(
  "/tasks/:id/attachments/settings",
  zValidator("json", plannerAttachmentSettingsSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const response: PlannerAttachmentSettingsResponse = {
        files_read: await plannerSetTaskFilesRead(context.db, {
          userId: context.user.id,
          taskId: parseTaskId(c.req.param("id")),
          filesRead: c.req.valid("json").files_read,
        }),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

/** The file name header, percent-decoded; a malformed value is kept as sent. */
function decodeHeaderName(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `planner/<user>/<uuid>/<safe name>`: the fork's own prefix in the shared bucket. */
function forkAttachmentObjectKey(userId: string, filename: string): string {
  const safe =
    filename.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
  return `planner/${userId}/${crypto.randomUUID()}/${safe}`;
}
