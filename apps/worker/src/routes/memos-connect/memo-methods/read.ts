import {
  getMemoByIdForViewer,
  listMemoAttachmentsForViewer,
  listMemoComments,
  listMemoReactions,
  listMemoRelationsForViewer,
  listMemos,
  listMemosForViewer,
} from "@flaremo/domain";
import {
  currentAttachmentToDto,
  currentMemoToDto,
  currentReactionToDto,
} from "@flaremo/memos";
import type { getRequestContext } from "../../../context";
import { resolveMemoCreator } from "../../../memos-compat/memo-creator";
import { memoRelationsToDtos } from "../../../memos-compat/memo-relations";
import { normalizeMemoName } from "../../../memos-compat/resource-names";
import type { BinaryTransport } from "../../../memos-protobuf";
import {
  type ConnectContext,
  type ConnectReadContext,
  optionalString,
  pageSize,
  record,
  requiredString,
} from "../shared";
import { connectErrorForTransport, connectValue } from "../transport";
import {
  connectMemoListQuery,
  connectMemoWithDetails,
  hydrateConnectPublicMemos,
  listMemoAttachmentsForPage,
  listMemoReactionsForPage,
} from "./details";

export async function listConnectMemos(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  const query = connectMemoListQuery(body);
  const result = await listMemos(context.db, context.user, query, {
    celScanLimit: context.memoFilterScanLimit,
  });
  const attachments = await listMemoAttachmentsForPage(
    context,
    result.memos.map((memo) => memo.id),
  );
  const reactions = await listMemoReactionsForPage(
    context,
    result.memos.map((memo) => memo.id),
  );
  return {
    memos: result.memos.map((memo) =>
      currentMemoToDto(memo, context.user, {
        attachments: attachments.get(memo.id) ?? [],
        reactions: reactions.get(memo.id) ?? [],
      }),
    ),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };
}

export async function getConnectMemo(
  context: Awaited<ReturnType<typeof getRequestContext>>,
  value: unknown,
) {
  const body = record(value);
  return connectMemoWithDetails(context, requiredString(body.name, "name"));
}

export async function connectPublicMemoRead(
  c: ConnectContext,
  context: ConnectReadContext,
  method: string,
  value: unknown,
  transport?: BinaryTransport,
) {
  const body = record(value);
  switch (method) {
    case "ListMemos": {
      const result = await listMemosForViewer(
        context.db,
        context.user,
        connectMemoListQuery(body),
        { celScanLimit: context.memoFilterScanLimit },
      );
      const memos = await hydrateConnectPublicMemos(context, result.memos);
      return connectValue(
        c,
        {
          memos,
          ...(result.nextPageToken
            ? { nextPageToken: result.nextPageToken }
            : {}),
        },
        transport,
      );
    }
    case "GetMemo":
      return connectValue(
        c,
        await connectPublicMemoWithDetails(
          context,
          requiredString(body.name, "name"),
        ),
        transport,
      );
    case "ListMemoComments": {
      const parentName = normalizeMemoName(requiredString(body.name, "name"));
      const result = await listMemoComments(context.db, context.user, {
        memoName: parentName,
        pageSize: pageSize(body.pageSize),
        ...(optionalString(body.pageToken)
          ? { pageToken: optionalString(body.pageToken) }
          : {}),
        orderBy: optionalString(body.orderBy) ?? "create_time desc",
      });
      const memos = await hydrateConnectPublicMemos(
        context,
        result.memos,
        parentName,
      );
      return connectValue(
        c,
        {
          memos,
          totalSize: result.totalSize,
          ...(result.nextPageToken
            ? { nextPageToken: result.nextPageToken }
            : {}),
        },
        transport,
      );
    }
    case "ListMemoReactions": {
      const result = await listMemoReactions(context.db, context.user, {
        memoName: normalizeMemoName(requiredString(body.name, "name")),
        pageSize: pageSize(body.pageSize),
        ...(optionalString(body.pageToken)
          ? { pageToken: optionalString(body.pageToken) }
          : {}),
      });
      return connectValue(
        c,
        {
          reactions: result.reactions.map(currentReactionToDto),
          totalSize: result.totalSize,
          ...(result.nextPageToken
            ? { nextPageToken: result.nextPageToken }
            : {}),
        },
        transport,
      );
    }
    case "ListMemoAttachments": {
      const attachments = await listMemoAttachmentsForViewer(
        context.db,
        context.user,
        normalizeMemoName(requiredString(body.name, "name")),
      );
      return connectValue(
        c,
        { attachments: attachments.map(currentAttachmentToDto) },
        transport,
      );
    }
    case "ListMemoRelations": {
      const memoId = normalizeMemoName(requiredString(body.name, "name"));
      await getMemoByIdForViewer(context.db, context.user, memoId);
      const rows = await listMemoRelationsForViewer(
        context.db,
        context.user,
        memoId,
      );
      const relations = await memoRelationsToDtos(
        rows,
        (id) => getMemoByIdForViewer(context.db, context.user, id),
        { skipUnavailable: true },
      );
      return connectValue(c, { relations }, transport);
    }
    default:
      return connectErrorForTransport(
        c,
        transport,
        "unimplemented",
        `Public Memos read method is not implemented: ${method}`,
        501,
      );
  }
}

export async function connectPublicMemoWithDetails(
  context: ConnectReadContext,
  memoId: string,
  parent?: string,
) {
  const memo = await getMemoByIdForViewer(context.db, context.user, memoId);
  const [attachments, reactions, relationRows] = await Promise.all([
    listMemoAttachmentsForViewer(context.db, context.user, memo.id),
    listMemoReactions(context.db, context.user, memo.id, { pageSize: 1_000 }),
    listMemoRelationsForViewer(context.db, context.user, memo.id),
  ]);
  const relations = await memoRelationsToDtos(
    relationRows,
    (id) => getMemoByIdForViewer(context.db, context.user, id),
    { skipUnavailable: true },
  );
  const creator = await resolveMemoCreator(context, memo);
  return currentMemoToDto(memo, creator, {
    attachments,
    reactions: reactions.reactions,
    relations,
    ...(parent ? { parent } : {}),
  });
}

export function isPublicMemoReadMethod(method: string) {
  return [
    "GetMemo",
    "ListMemos",
    "ListMemoComments",
    "ListMemoReactions",
    "ListMemoAttachments",
    "ListMemoRelations",
  ].includes(method);
}
