import type { MemoRow } from "@flaremo/db";
import { createMemoComment, listMemoComments } from "@flaremo/domain";
import type { Hono } from "hono";
import {
  getOptionalRequestContext,
  getRequestContext,
  type HonoBindings,
} from "../../context";
import { currentJsonError } from "../../memos-compat/current-errors";
import { hydrateSocialMemos, memoToCurrentDto } from "./hydrate";
import {
  type MemoCommentPage,
  memoPayload,
  normalizeMemoName,
  optionalString,
  parseVisibility,
  readJsonObject,
  readPageOptions,
  requiredString,
  unwrapResourceBody,
} from "./parsing";

export function registerCommentRoutes(app: Hono<HonoBindings>) {
  app.get("/memos/:memo/comments", async (c) => {
    try {
      const context = await getOptionalRequestContext(c);
      const memoName = normalizeMemoName(c.req.param("memo"));
      const page = readPageOptions(c, "create_time desc");
      const result: MemoCommentPage = await listMemoComments(
        context.db,
        context.user,
        {
          memoName,
          pageSize: page.pageSize,
          ...(page.pageToken ? { pageToken: page.pageToken } : {}),
          orderBy: page.orderBy,
        },
      );

      const memos = await hydrateSocialMemos(context, result.memos, memoName);

      return c.json({
        memos,
        totalSize: result.totalSize,
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/memos/:memo/comments", async (c) => {
    try {
      const context = await getRequestContext(c);
      const memoName = normalizeMemoName(c.req.param("memo"));
      const raw = await readJsonObject(c);
      const comment = unwrapResourceBody(raw, "comment");
      const content = requiredString(comment.content, "comment.content");
      const commentId =
        c.req.query("commentId") ??
        c.req.query("comment_id") ??
        optionalString(raw.commentId) ??
        optionalString(raw.comment_id);

      const created: MemoRow = await createMemoComment(
        context.db,
        context.user,
        memoName,
        {
          content,
          visibility: parseVisibility(comment.visibility),
          payload: memoPayload(comment),
          ...(commentId ? { commentId } : {}),
        },
        { userLimits: context.userLimits },
      );
      return c.json(await memoToCurrentDto(context, created, memoName));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });
}
