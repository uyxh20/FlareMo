import {
  bindMemoAttachments,
  createMemoComment,
  createMemoShare,
  deleteMemoReaction,
  getMemoById,
  listMemoAttachments,
  listMemoComments,
  listMemoReactions,
  listMemoRelationsForViewer,
  listMemoShares,
  replaceMemoRelations,
  revokeMemoShare,
  upsertMemoReaction,
} from "@flaremo/domain";
import {
  currentAttachmentToDto,
  currentReactionToDto,
  currentShareToDto,
} from "@flaremo/memos";
import type { getRequestContext } from "../../../context";
import { CompatValidationError } from "../../../memos-compat/errors";
import { memoRelationsToDtos } from "../../../memos-compat/memo-relations";
import { compatMemoRelationType } from "../../../memos-compat/parsing";
import { compatMemoPayload } from "../../../memos-compat/payload";
import { normalizeMemoName } from "../../../memos-compat/resource-names";
import { fetchLinkMetadata } from "../../../memos-link-metadata";
import type { BinaryTransport } from "../../../memos-protobuf";
import {
  type ConnectContext,
  list,
  optionalString,
  optionalTimestamp,
  pageSize,
  record,
  requiredString,
} from "../shared";
import { connectValue } from "../transport";
import { connectMemoWithDetails, hydrateConnectMemos } from "./details";

export async function createConnectMemoComment(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const comment = record(body.comment);
  const created = await createMemoComment(
    context.db,
    context.user,
    normalizeMemoName(requiredString(body.name, "name")),
    {
      content: requiredString(comment.content, "comment.content"),
      payload: compatMemoPayload(comment),
      source: "memos-connect",
      ...(optionalString(body.commentId)
        ? { commentId: optionalString(body.commentId) }
        : {}),
    },
    { userLimits: context.userLimits },
  );
  return connectMemoWithDetails(context, created.id);
}

export async function listConnectMemoComments(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const result = await listMemoComments(context.db, context.user, {
    memoName: normalizeMemoName(requiredString(body.name, "name")),
    pageSize: pageSize(body.pageSize),
    ...(optionalString(body.pageToken)
      ? { pageToken: optionalString(body.pageToken) }
      : {}),
    orderBy: optionalString(body.orderBy) ?? "create_time desc",
  });
  const comments = await hydrateConnectMemos(context, result.memos);
  return {
    memos: comments,
    totalSize: result.totalSize,
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };
}

export async function listConnectMemoReactions(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const result = await listMemoReactions(context.db, context.user, {
    memoName: normalizeMemoName(requiredString(body.name, "name")),
    pageSize: pageSize(body.pageSize),
    ...(optionalString(body.pageToken)
      ? { pageToken: optionalString(body.pageToken) }
      : {}),
  });
  return {
    reactions: result.reactions.map(currentReactionToDto),
    totalSize: result.totalSize,
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };
}

export async function upsertConnectMemoReaction(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const reaction = record(body.reaction);
  const memoName = normalizeMemoName(requiredString(body.name, "name"));
  const contentId = normalizeMemoName(
    optionalString(reaction.contentId) ?? memoName,
  );
  const created = await upsertMemoReaction(context.db, context.user, {
    memoName,
    contentId,
    reactionType: requiredString(
      reaction.reactionType,
      "reaction.reactionType",
    ),
  });
  return currentReactionToDto(created);
}

export async function deleteConnectMemoReaction(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const name = requiredString(body.name, "name");
  await deleteMemoReaction(context.db, context.user, {
    name,
    memoName: normalizeMemoName(reactionMemoName(name)),
  });
}

export async function createConnectMemoShare(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const memoShare = record(body.memoShare);
  const expireTime = optionalTimestamp(
    memoShare.expireTime ?? memoShare.expire_time,
    "memoShare.expireTime",
  );
  const share = await createMemoShare(
    context.db,
    context.user,
    normalizeMemoName(requiredString(body.parent, "parent")),
    { expires_at: expireTime },
  );
  return currentShareToDto(share);
}

export async function listConnectMemoShares(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const shares = await listMemoShares(
    context.db,
    context.user,
    normalizeMemoName(requiredString(body.parent, "parent")),
  );
  return { memoShares: shares.map(currentShareToDto) };
}

export async function deleteConnectMemoShare(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  await revokeMemoShare(
    context.db,
    context.user,
    shareTokenFromName(requiredString(body.name, "name")),
  );
}

export async function connectGetLinkMetadata(
  c: ConnectContext,
  value: unknown,
  transport?: BinaryTransport,
) {
  const body = record(value);
  return connectValue(
    c,
    await fetchLinkMetadata(requiredString(body.url, "url")),
    transport,
  );
}

export async function connectBatchGetLinkMetadata(
  c: ConnectContext,
  value: unknown,
  transport?: BinaryTransport,
) {
  const body = record(value);
  const urls = list(body.urls).map((url) => requiredString(url, "urls[]"));
  if (urls.length === 0) throw new CompatValidationError("urls are required");
  if (urls.length > 10)
    throw new CompatValidationError("too many urls (max 10)");
  const linkMetadata = await Promise.all(
    urls.map((url) => fetchLinkMetadata(url)),
  );
  return connectValue(c, { linkMetadata }, transport);
}

export async function setConnectAttachments(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const names = list(body.attachments).map((attachment) =>
    typeof attachment === "string"
      ? attachment
      : requiredString(record(attachment).name, "attachments[].name"),
  );
  await bindMemoAttachments(
    context.db,
    context.user,
    normalizeMemoName(requiredString(body.name, "name")),
    names,
  );
}

export async function listConnectAttachments(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const attachments = await listMemoAttachments(
    context.db,
    context.user,
    normalizeMemoName(requiredString(body.name, "name")),
  );
  return { attachments: attachments.map(currentAttachmentToDto) };
}

export async function setConnectRelations(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const relations = list(body.relations).map((value) => {
    const relation = record(value);
    const relatedMemo = record(relation.relatedMemo);
    return {
      related_memo:
        optionalString(relatedMemo.name) ??
        requiredString(relation.relatedMemo, "relations[].relatedMemo"),
      type: compatMemoRelationType(optionalString(relation.type)),
    };
  });
  await replaceMemoRelations(
    context.db,
    context.user,
    normalizeMemoName(requiredString(body.name, "name")),
    { relations },
  );
}

export async function listConnectRelations(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const memoId = normalizeMemoName(requiredString(record(value).name, "name"));
  const memo = await getMemoById(context.db, context.user, memoId, {
    includeDeleted: true,
  });
  const rows = await listMemoRelationsForViewer(
    context.db,
    context.user,
    memo.id,
  );
  const relations = await memoRelationsToDtos(rows, (id) =>
    getMemoById(context.db, context.user, id, { includeDeleted: true }),
  );
  return { relations };
}

function reactionMemoName(value: string) {
  const parts = value.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("reactions");
  if (marker <= 0 || marker + 2 !== parts.length) {
    throw new CompatValidationError("Invalid reaction name");
  }
  return parts.slice(0, marker).join("/");
}

function shareTokenFromName(value: string) {
  const parts = value.split("/").filter(Boolean);
  const marker = parts.lastIndexOf("shares");
  if (marker < 0 || marker + 2 !== parts.length) {
    throw new CompatValidationError("Invalid share name");
  }
  const token = parts[marker + 1];
  if (!token) throw new CompatValidationError("Invalid share name");
  return token;
}
