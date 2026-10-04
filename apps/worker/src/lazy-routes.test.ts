import { Hono } from "hono";
import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HonoBindings } from "./context";
import { mountLazyRoute } from "./lazy-routes";
import { createAppTestHarness } from "./test-support/app";
import { createTestRuntime } from "./test-support/runtime";

/**
 * Coverage for the lazy mount proxy itself.
 *
 * The route suites call handlers or drive the whole kernel, so the proxy in
 * `lazy-routes.ts` was only ever verified by hand: nothing asserted that a
 * mounted sub-app actually answers, that the loader runs once per isolate, that
 * the wildcard mount stops at the mount prefix, or that a broken sub-app fails
 * loudly. Those are the properties issue #138's laziness depends on — a proxy
 * that silently 404s would look like a working app and only cost CPU.
 *
 * Two layers, on purpose: the real `articlesApi` over a real Miniflare D1 (so
 * the proxy is proven against a route tree that needs auth context, params and
 * request bodies), and a minimal fake sub-app (so load counting and failure
 * modes are observable, which they are not for a module we cannot instrument).
 */

/** Mount path for the real-route layer; matches the kernel's own mount. */
const ARTICLES_PATH = "/api/app/articles";

let mf: Miniflare;
let env: Env;
let sessionCookie: string;

const { bootstrapAndSignIn } = createAppTestHarness(() => ({
  env,
  sessionCookie,
}));

/**
 * A bare host with the same lazy mount the kernel builds, plus a notFound that
 * is distinguishable from the sub-app's own 404s. Requests go through
 * `app.fetch` without an ExecutionContext, the way every Worker suite calls it.
 */
function hostWithLazyArticles(): Hono<HonoBindings> {
  const app = new Hono<HonoBindings>();
  app.notFound((c) => c.json({ error: { message: "host notFound" } }, 404));
  mountLazyRoute(app, ARTICLES_PATH, async () => {
    const { articlesApi } = await import("./routes/articles-api");
    return articlesApi;
  });
  return app;
}

function request(app: Hono<HonoBindings>, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init?.cookie) headers.set("cookie", init.cookie);
  // Cookie-session mutations still owe the exact trusted Origin, and the
  // check lives in the sub-app's own context resolution — so the proxy has to
  // hand the header through untouched.
  if (!["GET", "HEAD", "OPTIONS"].includes(init?.method ?? "GET")) {
    headers.set("origin", "http://flaremo.test");
  }
  return app.fetch(
    new Request(`http://flaremo.test${path}`, { ...init, headers }),
    env,
  );
}

describe("lazy mount over the real articles API", () => {
  beforeEach(async () => {
    ({ runtime: mf, env } = await createTestRuntime());
    sessionCookie = await bootstrapAndSignIn();
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("answers the mount path and keeps the sub-app's auth context", async () => {
    const app = hostWithLazyArticles();

    // The proxy hands `c.env` through, so the sub-app still resolves the
    // session out of the binding bag. An anonymous call must be the sub-app's
    // 401, not the host's 404 — that is what proves the request was forwarded
    // instead of swallowed.
    const anonymous = await request(app, ARTICLES_PATH);
    expect(anonymous.status).toBe(401);

    const authed = await request(app, ARTICLES_PATH, {
      cookie: sessionCookie,
    });
    expect(authed.status).toBe(200);
    expect((await authed.json()) as { articles: unknown[] }).toEqual({
      articles: [],
    });
  });

  it("re-bases sub-paths so params, bodies and query strings survive", async () => {
    const app = hostWithLazyArticles();

    const created = await request(app, ARTICLES_PATH, {
      method: "POST",
      cookie: sessionCookie,
      body: JSON.stringify({ title: "Lazy mount probe" }),
    });
    expect(created.status).toBe(201);
    const { article } = (await created.json()) as {
      article: { id: string; slug: string };
    };

    // `/api/app/articles` + `/:id` re-bases to `/<id>`; the id param and the
    // JSON body both have to arrive intact or the autosave PATCH is a no-op.
    const patched = await request(
      app,
      `${ARTICLES_PATH}/${encodeURIComponent(article.id)}`,
      {
        method: "PATCH",
        cookie: sessionCookie,
        body: JSON.stringify({ title: "Autosaved through the proxy" }),
      },
    );
    expect(patched.status).toBe(200);
    expect(
      ((await patched.json()) as { article: { title: string } }).article.title,
    ).toBe("Autosaved through the proxy");

    const fetched = await request(
      app,
      `${ARTICLES_PATH}/${encodeURIComponent(article.id)}`,
      { cookie: sessionCookie },
    );
    expect(fetched.status).toBe(200);
    // Reading the row back by id proves the re-based path and the `:id` param
    // line up; the title also proves the PATCH above really persisted.
    expect(
      ((await fetched.json()) as { article: { id: string; title: string } })
        .article,
    ).toMatchObject({ id: article.id, title: "Autosaved through the proxy" });

    // The query string must survive the re-basing too, or `include_deleted`
    // would silently drop the recycle bin.
    const list = await request(app, `${ARTICLES_PATH}?include_deleted=true`, {
      cookie: sessionCookie,
    });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { articles: unknown[] }).articles,
    ).toHaveLength(1);
  });

  it("reaches the sub-app's own 404 for an unknown id", async () => {
    const app = hostWithLazyArticles();
    const res = await request(
      app,
      `${ARTICLES_PATH}/00000000-0000-4000-8000-000000000000`,
      { cookie: sessionCookie },
    );
    // The domain's NotFoundError, not the host's blanket 404: the sub-app
    // answered, it just had no row.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Article not found");
  });
});

/**
 * The mechanism layer. Each case mounts a distinct path because `onceSubApp`
 * caches by mount path in module scope, exactly as it does per isolate — reuse
 * one path across cases and the second case would inherit the first case's
 * already-resolved sub-app and report a load count of zero.
 */
describe("mountLazyRoute", () => {
  it("loads the sub-app once and reuses it across requests", async () => {
    const app = new Hono<HonoBindings>();
    let loads = 0;
    mountLazyRoute(app, "/api/probe/once", async () => {
      loads += 1;
      const sub = new Hono<HonoBindings>();
      sub.get("/", (c) => c.json({ loads }));
      return sub;
    });

    for (const expected of [1, 1, 1]) {
      const res = await app.fetch(
        new Request("http://flaremo.test/api/probe/once"),
        {} as never,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ loads: expected });
    }
    expect(loads).toBe(1);
  });

  it("matches the mount path and its sub-paths without over-matching siblings", async () => {
    const app = new Hono<HonoBindings>();
    let loads = 0;
    app.notFound((c) => c.json({ error: { message: "host notFound" } }, 404));
    mountLazyRoute(app, "/api/probe/notes", async () => {
      loads += 1;
      const sub = new Hono<HonoBindings>();
      sub.get("/", (c) => c.json({ scope: "root" }));
      sub.get("/:id", (c) => c.json({ scope: "one", id: c.req.param("id") }));
      return sub;
    });

    const call = (path: string) =>
      app.fetch(new Request(`http://flaremo.test${path}`), {} as never);

    // The mount path itself, with and without the trailing slash. The static
    // mount 404'd on the trailing-slash form; the proxy re-bases it to "/", so
    // both spellings now reach the sub-app's root handler. Nothing in the
    // frontend sends the slashed form — recorded here because it is the one
    // observable difference from the static layout.
    for (const path of ["/api/probe/notes", "/api/probe/notes/"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ scope: "root" });
    }
    // Deeper sub-paths keep their remaining segments.
    const deep = await call("/api/probe/notes/42");
    expect(deep.status).toBe(200);
    expect(await deep.json()).toEqual({ scope: "one", id: "42" });

    // Prefixes that merely start with the mount path must not be captured —
    // otherwise a lazy wildcard would shadow a sibling route registered later.
    expect(loads).toBe(1);
    for (const path of [
      "/api/probe/notes-extra",
      "/api/probe/notesXYZ",
      "/api/probe/note",
      "/api/probe",
    ]) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { message: "host notFound" },
      });
    }
    // Not one of those reached the loader.
    expect(loads).toBe(1);
  });

  it("fails a crashing sub-app with 500 instead of a silent 404 or a hang", async () => {
    const app = new Hono<HonoBindings>();
    app.notFound((c) => c.json({ error: { message: "host notFound" } }, 404));
    mountLazyRoute(app, "/api/probe/crash", async () => {
      const sub = new Hono<HonoBindings>();
      sub.get("/", () => {
        throw new Error("sub-app boom");
      });
      return sub;
    });

    const res = await app.fetch(
      new Request("http://flaremo.test/api/probe/crash"),
      {} as never,
    );
    // Hono's built-in error handler inside the sub-app answers. The real route
    // trees wrap every handler in try/catch + jsonError, so this only covers a
    // sub-app that forgets to.
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("host notFound");
  });

  it("lets a sub-app that rethrows surface the error to the host", async () => {
    const app = new Hono<HonoBindings>();
    const observed: string[] = [];
    app.onError((error, c) => {
      observed.push((error as Error).message);
      return c.json({ error: { message: "host onError" } }, 500);
    });
    mountLazyRoute(app, "/api/probe/rethrow", async () => {
      const sub = new Hono<HonoBindings>();
      sub.onError((error) => {
        throw error;
      });
      sub.get("/", () => {
        throw new Error("bubbled up");
      });
      return sub;
    });

    const res = await app.fetch(
      new Request("http://flaremo.test/api/probe/rethrow"),
      {} as never,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: "host onError" } });
    expect(observed).toEqual(["bubbled up"]);
  });

  it("retries the loader after a failed import instead of caching the failure", async () => {
    const app = new Hono<HonoBindings>();
    const observed: string[] = [];
    app.onError((error, c) => {
      observed.push((error as Error).message);
      return c.json({ error: { message: "host onError" } }, 500);
    });
    let loads = 0;
    mountLazyRoute(app, "/api/probe/import-fails", async () => {
      loads += 1;
      if (loads === 1) throw new Error("import failed");
      const sub = new Hono<HonoBindings>();
      sub.get("/", (c) => c.json({ ok: true }));
      return sub;
    });

    const call = () =>
      app.fetch(
        new Request("http://flaremo.test/api/probe/import-fails"),
        {} as never,
      );

    // A loader rejection escapes the handler, so the host's error handling —
    // the same path the /api/v1/mcp legacy mount already relies on — sees it.
    const first = await call();
    expect(first.status).toBe(500);
    expect(observed).toEqual(["import failed"]);

    // The cache must not hold the rejection: the next request rebuilds.
    const second = await call();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    expect(loads).toBe(2);
  });
});
