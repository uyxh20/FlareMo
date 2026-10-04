import {
  bindMemoAttachments,
  createMemo,
  createMemoShare,
  getMemoByIdForViewer,
  getPublicShareByToken,
  listAttachmentsForMemosForViewer,
  listMemoAttachmentsForViewer,
  listMemoShares,
  listMemosForViewer,
  moveMemoToTrash,
  replaceMemoRelations,
  revokeMemoShare,
  updateMemo,
} from "@flaremo/domain";
import {
  currentAttachmentToDto,
  currentMemoToDto,
  currentShareToDto,
} from "@flaremo/memos";
import type { Hono } from "hono";
import {
  getOptionalRequestContext,
  getRequestContext,
  type HonoBindings,
} from "../../context";
import { hardDeleteMemoWithAttachments } from "../../memo-hard-delete";
import { currentJsonError } from "../../memos-compat/current-errors";
import { CompatValidationError } from "../../memos-compat/errors";
import { resolveMemoCreator } from "../../memos-compat/memo-creator";
import {
  compatMemoRelationType,
  compatMemoVisibility,
} from "../../memos-compat/parsing";
import { compatMemoPayload } from "../../memos-compat/payload";
import { normalizeMemoName } from "../../memos-compat/resource-names";
import {
  createAuthContext,
  currentListQuery,
  currentMemoWithDetails,
  currentRelations,
  currentUpdateInput,
  isLegacyWireRequest,
  isRecord,
  parseUpdateMask,
  readCurrentJsonObject,
  unwrapMemoBody,
  unwrapShareBody,
} from "./helpers";
import {
  currentMemoBodySchema,
  currentRelationBodySchema,
  currentShareBodySchema,
} from "./schemas";

export function registerMemoRoutes(app: Hono<HonoBindings>) {
  app.get("/memos", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getOptionalRequestContext(c);
      const result = await listMemosForViewer(
        context.db,
        context.user,
        currentListQuery(c),
        { celScanLimit: context.memoFilterScanLimit },
      );
      const attachments = await listAttachmentsForMemosForViewer(
        context.db,
        context.user,
        result.memos.map((memo) => memo.id),
      );
      const byMemo = new Map<string, typeof attachments>();
      for (const attachment of attachments) {
        if (!attachment.memoId) continue;
        const values = byMemo.get(attachment.memoId) ?? [];
        values.push(attachment);
        byMemo.set(attachment.memoId, values);
      }
      return c.json({
        memos: await Promise.all(
          result.memos.map(async (memo) =>
            currentMemoToDto(memo, await resolveMemoCreator(context, memo), {
              attachments: byMemo.get(memo.id) ?? [],
            }),
          ),
        ),
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/memos", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const body = unwrapMemoBody(
        currentMemoBodySchema.parse(await readCurrentJsonObject(c)),
      );
      if (body.memoId) {
        throw new CompatValidationError(
          "memoId is not supported; FlareMo generates memo resource names",
        );
      }
      if (typeof body.content !== "string" || !body.content.trim()) {
        throw new CompatValidationError("Memo content is required");
      }
      const context = await getRequestContext(c);
      const memo = await createMemo(
        context.db,
        context.user,
        {
          content: body.content.trim(),
          visibility: compatMemoVisibility(body.visibility),
          payload: compatMemoPayload(body),
          source: "memos-api",
        },
        { userLimits: context.userLimits, userId: context.user.id },
      );
      return c.json(await currentMemoWithDetails(context, memo));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.get("/memos/:memo", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getOptionalRequestContext(c);
      const memo = await getMemoByIdForViewer(
        context.db,
        context.user,
        normalizeMemoName(c.req.param("memo")),
      );
      return c.json(await currentMemoWithDetails(context, memo));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.patch("/memos/:memo", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const body = unwrapMemoBody(
        currentMemoBodySchema.parse(await readCurrentJsonObject(c)),
      );
      const updateMask = parseUpdateMask(
        c.req.query("updateMask") ?? body.updateMask,
      );
      const input = currentUpdateInput(body, updateMask);
      const context = await getRequestContext(c);
      const memo = await updateMemo(
        context.db,
        context.user,
        normalizeMemoName(c.req.param("memo")),
        input,
      );
      return c.json(await currentMemoWithDetails(context, memo));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.delete("/memos/:memo", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getRequestContext(c);
      const name = normalizeMemoName(c.req.param("memo"));
      if (c.req.query("force") === "true") {
        await hardDeleteMemoWithAttachments(
          c.env,
          context.db,
          context.user,
          name,
        );
      } else {
        await moveMemoToTrash(context.db, context.user, name);
      }
      return c.body(null, 200);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.get("/memos/:memo/attachments", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getOptionalRequestContext(c);
      const attachments = await listMemoAttachmentsForViewer(
        context.db,
        context.user,
        normalizeMemoName(c.req.param("memo")),
      );
      return c.json({ attachments: attachments.map(currentAttachmentToDto) });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.patch("/memos/:memo/attachments", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const body = unwrapMemoBody(
        currentMemoBodySchema.parse(await readCurrentJsonObject(c)),
      );
      const names = (body.attachments ?? []).flatMap((attachment) =>
        typeof attachment.name === "string" ? [attachment.name] : [],
      );
      const context = await getRequestContext(c);
      await bindMemoAttachments(
        context.db,
        context.user,
        normalizeMemoName(c.req.param("memo")),
        names,
      );
      return c.body(null, 200);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.get("/memos/:memo/relations", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getOptionalRequestContext(c);
      const relations = await currentRelations(
        context,
        normalizeMemoName(c.req.param("memo")),
      );
      return c.json({ relations });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.patch("/memos/:memo/relations", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const body = currentRelationBodySchema.parse(
        await readCurrentJsonObject(c),
      );
      const memoName = normalizeMemoName(c.req.param("memo"));
      const relationInput = body.relations.flatMap((relation) => {
        const relatedName =
          relation.related_memo ??
          (isRecord(relation.relatedMemo) &&
          typeof relation.relatedMemo.name === "string"
            ? relation.relatedMemo.name
            : undefined);
        if (!relatedName) return [];
        return [
          {
            related_memo: relatedName,
            type: compatMemoRelationType(relation.type),
          },
        ];
      });
      const context = await getRequestContext(c);
      await replaceMemoRelations(context.db, context.user, memoName, {
        relations: relationInput,
      });
      return c.body(null, 200);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.get("/memos/:memo/shares", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getRequestContext(c);
      const shares = await listMemoShares(
        context.db,
        context.user,
        normalizeMemoName(c.req.param("memo")),
      );
      return c.json({ memoShares: shares.map(currentShareToDto) });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/memos/:memo/shares", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const body = unwrapShareBody(
        currentShareBodySchema.parse(await readCurrentJsonObject(c)),
      );
      const context = await getRequestContext(c);
      const share = await createMemoShare(
        context.db,
        context.user,
        normalizeMemoName(c.req.param("memo")),
        {
          expires_at: body.expireTime ?? body.expiresAt ?? null,
        },
      );
      return c.json(currentShareToDto(share));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.delete("/memos/:memo/shares/:share", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const context = await getRequestContext(c);
      await revokeMemoShare(context.db, context.user, c.req.param("share"));
      return c.body(null, 200);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.get("/shares/:shareToken", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const db = (await createAuthContext(c)).db;
      const share = await getPublicShareByToken(db, c.req.param("shareToken"));
      return c.json(
        currentMemoToDto(share.memo, share.user, {
          attachments: share.attachments,
        }),
      );
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.get("/shares/:shareToken/memo", async (c, next) => {
    if (isLegacyWireRequest(c)) return next();
    try {
      const db = (await createAuthContext(c)).db;
      const share = await getPublicShareByToken(db, c.req.param("shareToken"));
      return c.json(
        currentMemoToDto(share.memo, share.user, {
          attachments: share.attachments,
        }),
      );
    } catch (error) {
      return currentJsonError(c, error);
    }
  });
}
