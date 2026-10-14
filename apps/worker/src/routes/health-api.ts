import {
  type HealthEntryResponse,
  type HealthKind,
  type HealthMemosResponse,
  type HealthRescanResponse,
  type HealthTargetsResponse,
  type HealthTrackerPreviewResponse,
  type HealthTrackerSaveResponse,
  type HealthTrackersResponse,
  type HealthTrackerTestResponse,
  type HealthWeekResponse,
  type HealthYearResponse,
  healthBuiltinWordsInputSchema,
  healthIsBuiltinKind,
  healthMemosQuerySchema,
  healthPatchEntrySchema,
  healthSetTargetsSchema,
  healthTrackerDraftSchema,
  healthTrackerInputSchema,
  healthTrackerTestSchema,
  healthWeekQuerySchema,
  healthYearQuerySchema,
} from "@flaremo/contracts";
import {
  healthArchiveTracker,
  healthCreateTracker,
  healthDismissEntry,
  healthEnsureScanned,
  healthListTrackers,
  healthPatchEntry,
  healthPreviewTracker,
  healthReadMemos,
  healthReadTargets,
  healthReadWeek,
  healthReadYear,
  healthRescan,
  healthSetBuiltinWords,
  healthSetTargets,
  healthTestTracker,
  healthUpdateTracker,
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

// --- Trackers ----------------------------------------------------------------
//
// The owner's own trackers and the built-ins' extra words (docs/fork-health-
// tracker.md, "Trackers"). Every save re-reads the whole diary so the rows match
// the new words at once; the preview reads it too but writes nothing.

healthApi.get("/trackers", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    const response: HealthTrackersResponse = {
      trackers: await healthListTrackers(db, user.id),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// Why one sentence counts or not. Pure: reads nothing.
healthApi.post(
  "/trackers/test",
  zValidator("json", healthTrackerTestSchema),
  async (c) => {
    try {
      await getRequestContext(c);
      const response: HealthTrackerTestResponse = healthTestTracker(
        c.req.valid("json"),
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// What saving a draft would change, read from the whole diary. Writes nothing.
healthApi.post(
  "/trackers/preview",
  zValidator("json", healthTrackerDraftSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "health", context.user.id);
      if (throttled) return throttled;
      const response: HealthTrackerPreviewResponse = await healthPreviewTracker(
        context.db,
        { userId: context.user.id, draft: c.req.valid("json") },
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

async function savedResponse(
  db: Parameters<typeof healthRescan>[0],
  userId: string,
): Promise<HealthTrackerSaveResponse> {
  const rescan = await healthRescan(db, userId);
  return { trackers: await healthListTrackers(db, userId), rescan };
}

healthApi.post(
  "/trackers",
  zValidator("json", healthTrackerInputSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "health", context.user.id);
      if (throttled) return throttled;
      await healthCreateTracker(context.db, {
        userId: context.user.id,
        tracker: c.req.valid("json"),
      });
      return c.json(await savedResponse(context.db, context.user.id), 201);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// A built-in kind (training, breath, night_out) takes only words; anything else
// is one of the owner's trackers and takes the whole tracker.
healthApi.put("/trackers/:id", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "health", context.user.id);
    if (throttled) return throttled;
    const id = c.req.param("id");
    const body: unknown = await c.req.json().catch(() => null);
    if (healthIsBuiltinKind(id)) {
      const parsed = healthBuiltinWordsInputSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { message: parsed.error.message } }, 400);
      }
      await healthSetBuiltinWords(context.db, {
        userId: context.user.id,
        kind: id as HealthKind,
        words: parsed.data,
      });
    } else {
      const parsed = healthTrackerInputSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { message: parsed.error.message } }, 400);
      }
      await healthUpdateTracker(context.db, {
        userId: context.user.id,
        id,
        tracker: parsed.data,
      });
    }
    return c.json(await savedResponse(context.db, context.user.id));
  } catch (error) {
    return jsonError(c, error);
  }
});

// Archives a tracker; its rows are hidden by the re-read, never deleted.
healthApi.delete("/trackers/:id", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "health", context.user.id);
    if (throttled) return throttled;
    await healthArchiveTracker(context.db, {
      userId: context.user.id,
      id: c.req.param("id"),
    });
    return c.json(await savedResponse(context.db, context.user.id));
  } catch (error) {
    return jsonError(c, error);
  }
});
