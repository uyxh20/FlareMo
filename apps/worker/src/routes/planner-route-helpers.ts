import { defaultKeyHasher } from "@better-auth/api-key";
import { plannerTodayWithinBounds } from "@flaremo/contracts";
import { type TaskActor, ValidationError } from "@flaremo/domain";
import type { Context } from "hono";
import type { HonoBindings, ReturnTypeOfRequestContext } from "../context";

// Helpers the planner's route files share (fork-owned add-on): planner-api.ts and
// planner-goals-api.ts, which planner-api.ts mounts. Kept in their own module so
// the sub-router does not import the router that mounts it.

// The actor of a planner write is derived from the credential: a PAT is an
// agent, a cookie session is the owner.
//
// This started as a copy of tasks-api.ts's `resolveActor`, which tests the
// `memos_pat_` prefix against the whole Authorization header ("Bearer …"), so
// it never produces a name and every agent write landed in the permanent
// archive with `actor_name = NULL` (fork review finding A04). The planner
// labels the agent `pat:` plus the first 8 characters of the token's stored
// hash (Better Auth keeps SHA-256, base64url, in `auth_apikeys.key`): that matches
// one key, and puts no part of the secret itself in the archive. Upstream's
// own task route still labels the same token with no name; that is upstream's
// to fix.
export async function plannerResolveActor(
  c: Context<HonoBindings>,
  credential: ReturnTypeOfRequestContext["credential"],
): Promise<TaskActor> {
  if (credential !== "pat") return { type: "user" };
  const header = c.req.raw.headers.get("authorization")?.trim() ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token.startsWith("memos_pat_")) return { type: "agent" };
  const hash = await defaultKeyHasher(token);
  return { type: "agent", name: `pat:${hash.slice(0, 8)}` };
}

// `today` is the client's local date. Local dates around the world span UTC-12
// to UTC+14, so a plausible one is within a day of the server's UTC date;
// anything else is a wrong clock or a bad request. The bound needs the server's
// clock, so it is checked here and not in the contract schemas.
export function plannerAssertToday(today: string, now: Date) {
  if (!plannerTodayWithinBounds(today, now)) {
    throw new ValidationError(
      "today must be within one day of the server's date.",
    );
  }
}
