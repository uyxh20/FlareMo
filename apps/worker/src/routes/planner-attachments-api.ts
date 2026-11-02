import {
  type PlannerAttachmentListResponse,
  type PlannerAttachmentResponse,
  type PlannerDeleteAttachmentResponse,
  plannerAttachmentMaxBytes,
  plannerAttachmentNameHeader,
} from "@flaremo/contracts";
import {
  assertAttachmentStorageQuota,
  DomainError,
  parseResourceName,
} from "@flaremo/domain";
import {
  plannerAddAttachment,
  plannerAssertAttachmentAllowed,
  plannerListAttachments,
  plannerLoadAttachment,
  plannerNormalizeAttachmentName,
  plannerRemoveAttachment,
} from "@flaremo/domain/src/planner";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import { forkTaskAttachmentResponse } from "../fork/task-attachments";
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

    // The declared size is checked before the body is read, so an oversized
    // upload is refused without buffering it. The real size is checked again.
    const declared = Number(c.req.header("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > plannerAttachmentMaxBytes) {
      throw new DomainError(
        `A file can be at most ${plannerAttachmentMaxBytes / (1024 * 1024)} MB.`,
        413,
      );
    }
    await plannerAssertAttachmentAllowed(context.db, {
      userId: context.user.id,
      taskId,
      size: Number.isFinite(declared) ? declared : 1,
    });

    const bytes = await c.req.arrayBuffer();
    await plannerAssertAttachmentAllowed(context.db, {
      userId: context.user.id,
      taskId,
      size: bytes.byteLength,
    });
    await assertAttachmentStorageQuota(
      context.db,
      context.limits,
      bytes.byteLength,
      { userLimits: context.userLimits, userId: context.user.id },
    );

    const filename = plannerNormalizeAttachmentName(
      decodeHeaderName(c.req.header(plannerAttachmentNameHeader)),
    );
    const contentType =
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ||
      "application/octet-stream";
    objectKey = forkAttachmentObjectKey(context.user.id, filename);
    const object = await c.env.ATTACHMENTS.put(objectKey, bytes, {
      httpMetadata: { contentType },
    });
    const attachment = await plannerAddAttachment(context.db, {
      user: context.user,
      actor: await plannerResolveActor(c, context.credential),
      taskId,
      filename,
      contentType,
      size: bytes.byteLength,
      r2Key: objectKey,
      etag: object.httpEtag,
    });
    objectKey = null;
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
