import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS modules without types
import { request } from "../../harness/core/transport.mjs";
import { fakeMcpServer, makeEnv, tmpHome } from "./helpers";

describe("transport request", () => {
  it("5xx is unreachable (snapshot fallback / outbox queue territory)", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    try {
      srv.mode.status = 503;
      const res = await request(
        "memory_compile",
        {},
        {
          env: makeEnv(home, srv.url),
          home,
        },
      );
      expect(res.ok).toBe(false);
      expect(res.unreachable).toBe(true);
      expect(res.status).toBe(503);
    } finally {
      await srv.close();
    }
  });

  it("4xx is a hard error, not unreachable", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    try {
      srv.mode.status = 400;
      const res = await request(
        "memory_compile",
        {},
        {
          env: makeEnv(home, srv.url),
          home,
        },
      );
      expect(res.ok).toBe(false);
      expect(res.unreachable).toBe(false);
      expect(res.status).toBe(400);

      srv.mode.status = 401;
      const auth = await request(
        "memory_compile",
        {},
        {
          env: makeEnv(home, srv.url),
          home,
        },
      );
      expect(auth.unreachable).toBe(false);
      expect(auth.auth).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("returns complete structured MCP results", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer({ memory_compile: { answer: "ok" } });
    try {
      const res = await request(
        "memory_compile",
        {},
        { env: makeEnv(home, srv.url), home },
      );
      expect(res).toEqual({
        ok: true,
        status: 200,
        data: { answer: "ok" },
      });
    } finally {
      await srv.close();
    }
  });

  it("treats an HTML 200 body as an unreachable protocol response", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    srv.mode.rawBody = "<html>gateway error</html>";
    try {
      const res = await request(
        "memory_remember",
        {},
        { env: makeEnv(home, srv.url), home },
      );
      expect(res.ok).toBe(false);
      expect(res.unreachable).toBe(true);
      expect(res.status).toBe(200);
      expect(res.error).toMatch(/invalid JSON response/);
    } finally {
      await srv.close();
    }
  });

  it("rejects a JSON 200 body with no MCP result", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    srv.mode.rawBody = JSON.stringify({ jsonrpc: "2.0", id: 1 });
    try {
      const res = await request(
        "memory_remember",
        {},
        { env: makeEnv(home, srv.url), home },
      );
      expect(res.ok).toBe(false);
      expect(res.unreachable).toBe(true);
      expect(res.error).toMatch(/missing result/);
    } finally {
      await srv.close();
    }
  });

  it("preserves JSON-RPC error envelopes without a result member", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    srv.mode.rawBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "memory backend unavailable" },
    });
    try {
      const res = await request(
        "memory_remember",
        {},
        { env: makeEnv(home, srv.url), home },
      );
      expect(res).toEqual({
        ok: false,
        status: 200,
        error: "MCP -32000: memory backend unavailable",
      });
      expect(res.unreachable).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it.each([
    ["empty object", JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })],
    ["array result", JSON.stringify({ jsonrpc: "2.0", id: 1, result: [1] })],
    [
      "primitive structuredContent",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: "ok" },
      }),
    ],
  ])("rejects a JSON 200 body with a %s result", async (_label, rawBody) => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    srv.mode.rawBody = rawBody;
    try {
      const res = await request(
        "memory_remember",
        {},
        { env: makeEnv(home, srv.url), home },
      );
      expect(res.ok).toBe(false);
      expect(res.unreachable).toBe(true);
      expect(res.status).toBe(200);
      expect(res.error).toMatch(
        /result (is empty|must be an object)|structuredContent must be an object/,
      );
    } finally {
      await srv.close();
    }
  });

  it("bounds response body reads by the request timeout", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    srv.mode.delayMs = 1000;
    try {
      const res = await request(
        "memory_remember",
        {},
        { env: makeEnv(home, srv.url), home, timeoutMs: 250 },
      );
      expect(res.ok).toBe(false);
      expect(res.unreachable).toBe(true);
      expect(res.status).toBe(200);
      expect(res.error).toMatch(/response body could not be read/);
    } finally {
      await srv.close();
    }
  });

  it("network failure is unreachable with status 0", async () => {
    const home = tmpHome();
    const res = await request(
      "memory_compile",
      {},
      { env: makeEnv(home, "http://127.0.0.1:1"), home, timeoutMs: 2000 },
    );
    expect(res.ok).toBe(false);
    expect(res.unreachable).toBe(true);
    expect(res.status).toBe(0);
  });
});
