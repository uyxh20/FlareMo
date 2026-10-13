import {
  type HealthEntryResponse,
  type HealthMemosResponse,
  type HealthRescanResponse,
  type HealthTargetsResponse,
  type HealthWeekResponse,
  type HealthYearResponse,
  healthMemosQuerySchema,
  healthPatchEntrySchema,
  healthSetTargetsSchema,
  healthWeekQuerySchema,
  healthYearQuerySchema,
} from "@flaremo/contracts";
import {
  healthDismissEntry,
  healthEnsureScanned,
  healthPatchEntry,
  healthReadMemos,
  healthReadTargets,
  healthReadWeek,
  healthReadYear,
  healthRescan,
  healthSetTargets,
} from "@flaremo/domain/src/health";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";

// The health tracker's HTTP API (fork-owned add-on, docs/fork-health-tracker.md),
// mounted lazily at /api/app/health-tracker and registered before /api/app, like
// planner-api.ts, so nothing there can shadow it. It is not /api/app/health:
// that exact path is upstream's instance info endpoint (`getAppInfo`), and a
// lazy mount at it would take the endpoint over.
//
// It authenticates exactly like the planner: `getRequestContext` accepts a
// cookie session (state-changing requests must carry FlareMo's Origin) or a
// `memos_pat_` PAT. All logic lives in packages/domain/src/health; the routes
// validate, authenticate, throttle and serialise. The first read of a user who
// has never been read triggers the one-time scan of the whole diary.

export const healthApi = new Hono<HonoBindings>();

// A uniform JSON envelope for unknown paths, like every other /api/* 404.
healthApi.notFound((c) => c.json({ error: { message: "Not found" } }, 404));

// --- Reads -----------------------------------------------------------------

// Seven days from `start` (the last seven days ending today when absent): the
// entries and the summary against the targets.
healthApi.get(
  "/week",
  zValidator("query", healthWeekQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      await healthEnsureScanned(db, user.id);
      const week: HealthWeekResponse = await healthReadWeek(db, {
        userId: user.id,
        start: c.req.valid("query").start,
      });
      return c.json(week);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// One year's per-day aggregates, the night-out budget and its pace.
healthApi.get(
  "/year",
  zValidator("query", healthYearQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      await healthEnsureScanned(db, user.id);
      const year: HealthYearResponse = await healthReadYear(db, {
        userId: user.id,
        year: c.req.valid("query").year,
      });
      return c.json(year);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// The labels of a whole page of the timeline in one request.
healthApi.get(
  "/memos",
  zValidator("query", healthMemosQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      await healthEnsureScanned(db, user.id);
      const response: HealthMemosResponse = {
        memos: await healthReadMemos(db, {
          userId: user.id,
          ids: c.req.valid("query").ids,
        }),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

healthApi.get("/targets", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    const response: HealthTargetsResponse = {
      targets: await healthReadTargets(db, user.id),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// --- Writes ----------------------------------------------------------------

// The owner fixes a row: home time, variant, minutes or day. The row becomes
// "edited", which a re-read of the diary leaves alone.
healthApi.patch(
  "/entries/:id",
  zValidator("json", healthPatchEntrySchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "health", context.user.id);
      if (throttled) return throttled;
      const response: HealthEntryResponse = {
        entry: await healthPatchEntry(context.db, {
          userId: context.user.id,
          entryId: c.req.param("id"),
          patch: c.req.valid("json"),
        }),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// The × on a label. The row is kept and marked dismissed, so a re-read of the
// diary does not bring it back.
healthApi.post("/entries/:id/dismiss", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "health", context.user.id);
    if (throttled) return throttled;
    const response: HealthEntryResponse = {
      entry: await healthDismissEntry(context.db, {
        userId: context.user.id,
        entryId: c.req.param("id"),
      }),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// "Re-read diary": every memo again. Rows the owner edited or dismissed keep
// their state.
healthApi.post("/rescan", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "health", context.user.id);
    if (throttled) return throttled;
    const response: HealthRescanResponse = await healthRescan(
      context.db,
      context.user.id,
    );
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

healthApi.put(
  "/targets",
  zValidator("json", healthSetTargetsSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "health", context.user.id);
      if (throttled) return throttled;
      await healthSetTargets(context.db, {
        userId: context.user.id,
        ...c.req.valid("json"),
      });
      const response: HealthTargetsResponse = {
        targets: await healthReadTargets(context.db, context.user.id),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);
