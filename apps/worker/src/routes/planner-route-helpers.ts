import { plannerTodayWithinBounds } from "@flaremo/contracts";
import { type TaskActor, ValidationError } from "@flaremo/domain";
import type { Context } from "hono";
import type { HonoBindings, ReturnTypeOfRequestContext } from "../context";

// Helpers the planner's route files share (fork-owned add-on): planner-api.ts and
// planner-goals-api.ts, which planner-api.ts mounts. Kept in their own module so
// the sub-router does not import the router that mounts it.

// A copy of tasks-api.ts's `resolveActor`, which is not exported. Agents write
// through the same route as the browser, so the actor is derived from the
// credential: a PAT is an agent (labelled with a short token hint so the
// activity trail stays attributable), a cookie session is the owner.
//
// Kept identical on purpose, bug included: it tests the `memos_pat_` prefix on
// the whole Authorization header, which starts with "Bearer ", so the hint is
// never produced and a PAT is an agent with no name. Fixing it here alone would
// label one token differently through the two APIs; fix both, or export one.
export function plannerResolveActor(
  c: Context<HonoBindings>,
  credential: ReturnTypeOfRequestContext["credential"],
): TaskActor {
  if (credential !== "pat") return { type: "user" };
  const token = c.req.raw.headers.get("authorization")?.trim() ?? "";
  const hint = token.startsWith("memos_pat_")
    ? token.slice("memos_pat_".length, "memos_pat_".length + 8)
    : null;
  return { type: "agent", name: hint ? `pat:${hint}` : undefined };
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
