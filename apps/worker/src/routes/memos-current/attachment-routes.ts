import {
  assertAttachmentStorageQuota,
  bindMemoAttachments,
  createAttachmentMetadata,
  DomainError,
  getAttachmentById,
  listAttachments,
} from "@flaremo/domain";
import { currentAttachmentToDto } from "@flaremo/memos";
import type { Hono } from "hono";
import {
  createAttachmentObjectKey,
  MAX_ATTACHMENT_BYTES,
} from "../../attachment-http";
import { getRequestContext, type HonoBindings } from "../../context";
import { deleteMemosAttachment } from "../../memos-compat/attachment-delete";
import { currentJsonError } from "../../memos-compat/current-errors";
import { CompatValidationError } from "../../memos-compat/errors";
import { normalizeAttachmentName } from "../../memos-compat/resource-names";
import {
  currentRequiredString,
  decodeBase64,
  isLegacyWireRequest,
  parsePageSize,
  parseUpdateMask,
  readCurrentJsonObject,
  unwrapAttachmentBody,
  unwrapAttachmentPatchBody,
} from "./helpers";
import {
  currentAttachmentBodySchema,
  currentAttachmentPatchBodySchema,
} from "./schemas";

export function registerAttachmentRoutes(app: Hono<HonoBindings>) {
  app.get("/attachments", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getRequestContext(c);
      const attachments = await listAttachments(context.db, context.user, {
        memoId: c.req.query("memo"),
        pageSize: parsePageSize(c.req.query("pageSize"), 50),
      });
      return c.json({ attachments: attachments.map(currentAttachmentToDto) });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/attachments", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    if (
      !c.req.header("content-type")?.toLowerCase().includes("application/json")
    ) {
      return next();
    }
    try {
      const body = unwrapAttachmentBody(
        currentAttachmentBodySchema.parse(await readCurrentJsonObject(c)),
      );
      if (body.attachmentId) {
        throw new CompatValidationError(
          "attachmentId is not supported; FlareMo generates attachment resource names",
        );
      }
      if (body.externalLink) {
        throw new CompatValidationError(
          "External attachments are not supported by FlareMo",
        );
      }
      if (!body.content)
        throw new CompatValidationError("Attachment content is required");
      const filename = currentRequiredString(body.filename, "filename");
      const type = currentRequiredString(body.type, "type");
      const bytes = decodeBase64(body.content);
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new DomainError("Attachment exceeds the 25 MiB limit", 413);
      }
      const context = await getRequestContext(c);
      await assertAttachmentStorageQuota(
        context.db,
        context.limits,
        bytes.byteLength,
        { userLimits: context.userLimits, userId: context.user.id },
      );
      const objectKey = createAttachmentObjectKey(
        context.user.id,
        filename,
        "memos",
      );
      const object = await c.env.ATTACHMENTS.put(objectKey, bytes, {
        httpMetadata: { contentType: type },
      });
      try {
        const attachment = await createAttachmentMetadata(
          context.db,
          context.user,
          {
            memoId: body.memo ?? null,
            filename,
            contentType: type,
            size: bytes.byteLength,
            r2Key: objectKey,
            etag: object.httpEtag,
          },
        );
        return c.json(currentAttachmentToDto(attachment));
      } catch (error) {
        await c.env.ATTACHMENTS.delete(objectKey);
        throw error;
      }
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.get("/attachments/:attachment", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getRequestContext(c);
      const attachment = await getAttachmentById(
        context.db,
        context.user,
        normalizeAttachmentName(c.req.param("attachment")),
      );
      return c.json(currentAttachmentToDto(attachment));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.patch("/attachments/:attachment", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const rawBody = currentAttachmentPatchBodySchema.parse(
        await readCurrentJsonObject(c),
      );
      const body = unwrapAttachmentPatchBody(rawBody);
      const updateMask = parseUpdateMask(
        c.req.query("updateMask") ?? rawBody.updateMask,
      );
      if (!updateMask.every((field) => field === "memo")) {
        throw new CompatValidationError(
          "Only the attachment memo field is mutable",
        );
      }
      if (!body.memo) throw new CompatValidationError("A memo is required");
      const context = await getRequestContext(c);
      const attachment = await getAttachmentById(
        context.db,
        context.user,
        normalizeAttachmentName(c.req.param("attachment")),
      );
      await bindMemoAttachments(context.db, context.user, body.memo, [
        attachment.id,
      ]);
      const updated = await getAttachmentById(
        context.db,
        context.user,
        attachment.id,
      );
      return c.json(currentAttachmentToDto(updated));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.delete("/attachments/:attachment", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getRequestContext(c);
      await deleteMemosAttachment(
        c.env,
        context.db,
        context.user,
        normalizeAttachmentName(c.req.param("attachment")),
      );
      return c.body(null, 200);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });
}
