import {
  bindMemoAttachments,
  createMemoComment,
  deleteMemoReaction,
  listMemoAttachments,
  listMemoComments,
  listMemoReactions,
  listMemoRelations,
  replaceMemoRelations,
  upsertMemoReaction,
  ValidationError,
} from "@flaremo/domain";
import {
  currentMemoToDto,
  currentReactionToDto,
  parseMemosResourceName,
} from "@flaremo/memos";
import type { ReturnTypeOfRequestContext } from "../../../context";
import {
  isJsonObject,
  type JsonObject,
  optionalString,
} from "../../../mcp-protocol";
import {
  attachmentToCurrentMemosDto,
  firstDefined,
  memoPayloadFromInput,
  mergedResourceInput,
  normalizeMemoName,
  normalizeRelationType,
  normalizeVisibility,
  pageSize,
  relationToCurrentMemosDto,
  requiredString,
  resourceName,
} from "../input";

export async function streamableListMemoAttachments(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const pageToken = optionalString(args, "pageToken");
  if (pageToken)
    throw new ValidationError(
      "pageToken is not supported for memo attachments.",
    );
  const rows = await listMemoAttachments(
    context.db,
    context.user,
    parseMemosResourceName(resourceName(args, "memo", "name")),
  );
  const size = pageSize(args);
  return {
    attachments: rows.slice(0, size).map(attachmentToCurrentMemosDto),
  };
}

export async function streamableSetMemoAttachments(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const rawAttachments = args.attachments;
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 100) {
    throw new ValidationError(
      "attachments must be an array with at most 100 entries.",
    );
  }
  const names = rawAttachments.map((attachment, index) => {
    if (typeof attachment === "string") return attachment;
    if (isJsonObject(attachment)) {
      return requiredString(attachment.name, `attachments[${index}].name`);
    }
    throw new ValidationError(
      `attachments[${index}] must be a resource name or object.`,
    );
  });
  await bindMemoAttachments(
    context.db,
    context.user,
    parseMemosResourceName(resourceName(args, "memo", "name")),
    names,
  );
  return { ok: true };
}

export async function streamableListMemoRelations(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const pageToken = optionalString(args, "pageToken");
  if (pageToken)
    throw new ValidationError("pageToken is not supported for memo relations.");
  const rows = await listMemoRelations(
    context.db,
    context.user,
    parseMemosResourceName(resourceName(args, "memo", "name")),
  );
  return { relations: rows.map(relationToCurrentMemosDto) };
}

export async function streamableSetMemoRelations(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const rawRelations = args.relations;
  if (!Array.isArray(rawRelations) || rawRelations.length > 100) {
    throw new ValidationError(
      "relations must be an array with at most 100 entries.",
    );
  }
  const targetName = parseMemosResourceName(resourceName(args, "memo", "name"));
  const relations = rawRelations.map((rawRelation, index) => {
    if (!isJsonObject(rawRelation)) {
      throw new ValidationError(`relations[${index}] must be an object.`);
    }
    const relatedMemo = rawRelation.relatedMemo;
    const relatedName = isJsonObject(relatedMemo)
      ? requiredString(relatedMemo.name, `relations[${index}].relatedMemo.name`)
      : requiredString(
          firstDefined(rawRelation.related_memo, relatedMemo),
          `relations[${index}].relatedMemo`,
        );
    const sourceMemo = rawRelation.memo;
    if (isJsonObject(sourceMemo) && sourceMemo.name !== undefined) {
      const sourceName = requiredString(
        sourceMemo.name,
        `relations[${index}].memo.name`,
      );
      if (parseMemosResourceName(sourceName) !== targetName) {
        throw new ValidationError(
          `relations[${index}].memo must match the target memo.`,
        );
      }
    }
    return {
      related_memo: relatedName,
      type: normalizeRelationType(rawRelation.type),
    };
  });
  await replaceMemoRelations(context.db, context.user, targetName, {
    relations,
  });
  return { ok: true };
}

export async function streamableListMemoComments(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const parentName = normalizeMemoName(resourceName(args, "memo", "name"));
  const result = await listMemoComments(context.db, context.user, parentName, {
    pageSize: pageSize(args),
    pageToken: optionalString(args, "pageToken", "page_token"),
    orderBy: optionalString(args, "orderBy", "order_by"),
  });
  return {
    memos: result.memos.map((memo) =>
      currentMemoToDto(memo, context.user, { parent: parentName }),
    ),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };
}

export async function streamableCreateMemoComment(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const parentName = normalizeMemoName(resourceName(args, "memo", "name"));
  const input = mergedResourceInput(args, "body", "comment");
  const content = requiredString(input.content, "content");
  const created = await createMemoComment(
    context.db,
    context.user,
    parentName,
    {
      content,
      visibility: normalizeVisibility(input.visibility),
      payload: memoPayloadFromInput(input),
      source: optionalString(input, "source") ?? "mcp",
      ...(optionalString(input, "commentId", "comment_id")
        ? { commentId: optionalString(input, "commentId", "comment_id") }
        : {}),
    },
    { userLimits: context.userLimits },
  );
  return currentMemoToDto(created, context.user, { parent: parentName });
}

export async function streamableListMemoReactions(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const memoName = normalizeMemoName(resourceName(args, "memo", "name"));
  const result = await listMemoReactions(context.db, context.user, memoName, {
    pageSize: pageSize(args),
    pageToken: optionalString(args, "pageToken", "page_token"),
  });
  return {
    reactions: result.reactions.map(currentReactionToDto),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };
}

export async function streamableUpsertMemoReaction(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const memoName = normalizeMemoName(resourceName(args, "memo", "name"));
  const input = mergedResourceInput(args, "reaction");
  const reactionType = requiredString(
    firstDefined(input.reactionType, input.reaction_type),
    "reactionType",
  );
  const contentId = optionalString(input, "contentId", "content_id");
  const reaction = await upsertMemoReaction(
    context.db,
    context.user,
    memoName,
    {
      reactionType,
      ...(contentId ? { contentId } : {}),
    },
  );
  return currentReactionToDto(reaction);
}

export async function streamableDeleteMemoReaction(
  context: ReturnTypeOfRequestContext,
  args: JsonObject,
) {
  const memoName = normalizeMemoName(resourceName(args, "memo", "name"));
  const reactionId = requiredString(args.reaction, "reaction");
  const reactionName = reactionId.includes("/reactions/")
    ? reactionId
    : `${memoName}/reactions/${reactionId.replace(/^reactions\//, "")}`;
  await deleteMemoReaction(context.db, context.user, {
    name: reactionName,
    memoName,
  });
  return { ok: true };
}
