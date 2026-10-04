import type { ReactionRow } from "@flaremo/db";
import {
  deleteMemoReaction,
  listMemoReactions,
  upsertMemoReaction,
} from "@flaremo/domain";
import type { Hono } from "hono";
import {
  getOptionalRequestContext,
  getRequestContext,
  type HonoBindings,
} from "../../context";
import {
  currentJsonError,
  ValidationCurrentError,
} from "../../memos-compat/current-errors";
import { reactionToDto } from "./hydrate";
import {
  type MemoReactionPage,
  normalizeMemoName,
  readJsonObject,
  readPageOptions,
  requiredPathSegment,
  requiredString,
  unwrapResourceBody,
} from "./parsing";

export function registerReactionRoutes(app: Hono<HonoBindings>) {
  app.get("/memos/:memo/reactions", async (c) => {
    try {
      const context = await getOptionalRequestContext(c);
      const memoName = normalizeMemoName(c.req.param("memo"));
      const page = readPageOptions(c);
      const result: MemoReactionPage = await listMemoReactions(
        context.db,
        context.user,
        {
          memoName,
          pageSize: page.pageSize,
          ...(page.pageToken ? { pageToken: page.pageToken } : {}),
        },
      );

      return c.json({
        reactions: result.reactions.map((reaction) => reactionToDto(reaction)),
        totalSize: result.totalSize,
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/memos/:memo/reactions", async (c) => {
    try {
      const context = await getRequestContext(c);
      const memoName = normalizeMemoName(c.req.param("memo"));
      const raw = await readJsonObject(c);
      const reaction = unwrapResourceBody(raw, "reaction");
      const contentId = requiredString(
        reaction.contentId ?? reaction.content_id,
        "reaction.contentId",
      );
      if (normalizeMemoName(contentId) !== memoName) {
        throw new ValidationCurrentError(
          "reaction.contentId must match the memo resource",
        );
      }
      const reactionType = requiredString(
        reaction.reactionType ?? reaction.reaction_type,
        "reaction.reactionType",
      );
      const created: ReactionRow = await upsertMemoReaction(
        context.db,
        context.user,
        { memoName, contentId: memoName, reactionType },
      );
      return c.json(reactionToDto(created));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.delete("/memos/:memo/reactions/:reaction", async (c) => {
    try {
      const context = await getRequestContext(c);
      const memoName = normalizeMemoName(c.req.param("memo"));
      const reactionId = requiredPathSegment(
        c.req.param("reaction"),
        "reaction",
      );
      await deleteMemoReaction(context.db, context.user, {
        name: `${memoName}/reactions/${reactionId}`,
        memoName,
        reactionId,
      });
      return c.body(null, 200);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });
}
