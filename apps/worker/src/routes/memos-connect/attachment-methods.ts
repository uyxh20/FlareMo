import {
  assertAttachmentStorageQuota,
  compileAttachmentFilter,
  createAttachmentMetadata,
  getAttachmentById,
  listAttachmentsPage,
  updateAttachmentMemo,
} from "@flaremo/domain";
import {
  currentAttachmentsToListResponse,
  currentAttachmentToDto,
} from "@flaremo/memos";
import {
  createAttachmentObjectKey,
  MAX_ATTACHMENT_BYTES,
} from "../../attachment-http";
import type { FlareMoEnv } from "../../env";
import { deleteMemosAttachment } from "../../memos-compat/attachment-delete";
import { CompatValidationError } from "../../memos-compat/errors";
import { normalizeAttachmentName } from "../../memos-compat/resource-names";
import type { BinaryTransport } from "../../memos-protobuf";
import {
  attachmentBytes,
  type ConnectContext,
  type ConnectRequestContext,
  fieldMaskPaths,
  list,
  optionalString,
  pageSize,
  record,
  requiredString,
} from "./shared";
import { connectErrorForTransport, connectValue } from "./transport";

export async function connectAttachmentMethod(
  c: ConnectContext,
  context: ConnectRequestContext,
  method: string,
  value: unknown,
  transport?: BinaryTransport,
) {
  const body = record(value);
  switch (method) {
    case "CreateAttachment": {
      const attachment = await createConnectAttachment(
        c.env,
        context,
        record(body.attachment),
        optionalString(body.attachmentId),
      );
      return connectValue(c, currentAttachmentToDto(attachment), transport);
    }
    case "ListAttachments": {
      const filterExpression = optionalString(body.filter);
      const filterPredicate = await compileAttachmentFilter(filterExpression);
      const result = await listAttachmentsPage(context.db, context.user, {
        pageSize: pageSize(body.pageSize),
        pageToken: optionalString(body.pageToken),
        orderBy: optionalString(body.orderBy),
        ...(filterPredicate
          ? {
              filterPredicate,
              filterExpression,
            }
          : {}),
      });
      return connectValue(
        c,
        currentAttachmentsToListResponse(result.attachments, {
          nextPageToken: result.nextPageToken,
          totalSize: result.totalSize,
        }),
        transport,
      );
    }
    case "GetAttachment": {
      const attachment = await getAttachmentById(
        context.db,
        context.user,
        normalizeAttachmentName(requiredString(body.name, "name")),
      );
      return connectValue(c, currentAttachmentToDto(attachment), transport);
    }
    case "UpdateAttachment": {
      const attachment = record(body.attachment);
      const fields = fieldMaskPaths(body.updateMask);
      if (fields.length !== 1 || fields[0] !== "memo") {
        throw new CompatValidationError(
          "Only the attachment memo field is mutable",
        );
      }
      const updated = await updateAttachmentMemo(
        context.db,
        context.user,
        normalizeAttachmentName(
          requiredString(attachment.name, "attachment.name"),
        ),
        optionalString(attachment.memo) ?? null,
      );
      return connectValue(c, currentAttachmentToDto(updated), transport);
    }
    case "DeleteAttachment": {
      await deleteConnectAttachment(
        c.env,
        context,
        requiredString(body.name, "name"),
      );
      return connectValue(c, {}, transport);
    }
    case "BatchDeleteAttachments": {
      const names = list(body.names).map((name) =>
        requiredString(name, "names[]"),
      );
      for (const name of names) {
        await deleteConnectAttachment(c.env, context, name);
      }
      return connectValue(c, {}, transport);
    }
    default:
      return connectErrorForTransport(
        c,
        transport,
        "unimplemented",
        `Attachment method is not implemented: ${method}`,
        501,
      );
  }
}

async function createConnectAttachment(
  env: FlareMoEnv,
  context: ConnectRequestContext,
  attachment: Record<string, unknown>,
  attachmentId?: string,
) {
  if (attachmentId) {
    throw new CompatValidationError(
      "attachmentId is not supported; FlareMo generates attachment resource names",
    );
  }
  if (optionalString(attachment.externalLink)) {
    throw new CompatValidationError(
      "External attachments are not supported by FlareMo",
    );
  }
  const filename = requiredString(attachment.filename, "attachment.filename");
  const type = requiredString(attachment.type, "attachment.type");
  const bytes = attachmentBytes(attachment.content);
  if (bytes.byteLength === 0) {
    throw new CompatValidationError("attachment.content is required");
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new CompatValidationError("Attachment exceeds the 25 MiB limit");
  }
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
  const object = await env.ATTACHMENTS.put(objectKey, bytes, {
    httpMetadata: { contentType: type },
  });
  try {
    return await createAttachmentMetadata(context.db, context.user, {
      memoId: optionalString(attachment.memo) ?? null,
      filename,
      contentType: type,
      size: bytes.byteLength,
      r2Key: objectKey,
      etag: object.httpEtag,
    });
  } catch (error) {
    await env.ATTACHMENTS.delete(objectKey);
    throw error;
  }
}

async function deleteConnectAttachment(
  env: FlareMoEnv,
  context: ConnectRequestContext,
  name: string,
) {
  await deleteMemosAttachment(
    env,
    context.db,
    context.user,
    normalizeAttachmentName(name),
  );
}
