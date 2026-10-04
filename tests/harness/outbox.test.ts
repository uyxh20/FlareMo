import { openSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS modules without types
import {
  enqueueOutbox,
  flushOutbox,
  sweepSessions,
} from "../../harness/core/outbox.mjs";
// @ts-expect-error plain-JS modules without types
import {
  failedPath,
  flushLockPath,
  pendingPath,
  sessionsDir,
} from "../../harness/core/paths.mjs";
// @ts-expect-error plain-JS modules without types
import {
  newSession,
  readJsonl,
  saveSession,
} from "../../harness/core/state.mjs";
import { makeEnv, tmpHome } from "./helpers";

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

function okReq(calls: Call[]) {
  return async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    return { ok: true, status: 200, data: { id: "m1" } };
  };
}

describe("outbox flush", () => {
  it("drops entries on success", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    enqueueOutbox(home, {
      id: "k1",
      tool: "memory_remember",
      args: { content: "x" },
    });
    const calls: Call[] = [];
    const r = await flushOutbox(home, { env, requestImpl: okReq(calls) });
    expect(r.sent).toBe(1);
    expect(calls[0].tool).toBe("memory_remember");
    expect(readJsonl(pendingPath(home))).toEqual([]);
  });

  it("caps request timeout at the remaining flush budget", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    enqueueOutbox(home, { id: "budget-1", tool: "memory_remember", args: {} });
    enqueueOutbox(home, { id: "budget-2", tool: "memory_remember", args: {} });
    let current = 0;
    const timeouts: number[] = [];
    const requestImpl = async (
      _tool: string,
      _args: Record<string, unknown>,
      options: { timeoutMs: number },
    ) => {
      timeouts.push(options.timeoutMs);
      current = 50;
      return { ok: true, status: 200, data: {} };
    };

    const result = await flushOutbox(home, {
      env,
      requestImpl,
      budgetMs: 50,
      timeoutMs: 8_000,
      now: () => current,
      sweep: false,
    });

    expect(result.sent).toBe(1);
    expect(result.kept).toBe(1);
    expect(timeouts).toEqual([50]);
    expect(
      readJsonl(pendingPath(home)).map((entry: { id: string }) => entry.id),
    ).toEqual(["budget-2"]);
  });

  it("moves 4xx / tool errors to failed.jsonl", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    enqueueOutbox(home, { id: "k2", tool: "memory_remember", args: {} });
    enqueueOutbox(home, { id: "k3", tool: "memory_remember", args: {} });
    const req = async () => ({ ok: false, status: 400, error: "bad" });
    const r = await flushOutbox(home, { env, requestImpl: req, sweep: false });
    expect(r.failed).toBe(2);
    expect(readJsonl(pendingPath(home))).toEqual([]);
    expect(
      readJsonl(failedPath(home)).map((e: { id: string }) => e.id),
    ).toEqual(["k2", "k3"]);
  });

  it("keeps entries on network/5xx and bumps attempts", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    enqueueOutbox(home, { id: "k4", tool: "memory_remember", args: {} });
    const down = async () => ({
      ok: false,
      status: 0,
      unreachable: true,
      error: "down",
    });
    await flushOutbox(home, { env, requestImpl: down, sweep: false });
    let pending = readJsonl(pendingPath(home));
    expect(pending[0].attempts).toBe(1);

    const fivexx = async () => ({ ok: false, status: 503, error: "oops" });
    await flushOutbox(home, { env, requestImpl: fivexx, sweep: false });
    pending = readJsonl(pendingPath(home));
    expect(pending[0].attempts).toBe(2);
  });

  it("enqueue sets args.idempotency_key = entry id when missing", () => {
    const home = tmpHome();
    const e = enqueueOutbox(home, {
      tool: "memory_remember",
      args: { content: "hello" },
    });
    expect(e.args.idempotency_key).toBe(e.id);
    expect(e.id.length).toBeLessThanOrEqual(128);
    const onDisk = readJsonl(pendingPath(home))[0];
    expect(onDisk.args.idempotency_key).toBe(e.id);

    // caller-provided key wins
    const e2 = enqueueOutbox(home, {
      id: "import:zcode:abc",
      tool: "memory_remember",
      args: { content: "x", idempotency_key: "caller-key" },
    });
    expect(e2.args.idempotency_key).toBe("caller-key");
  });

  it("skips while a fresh flush.lock is held", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    enqueueOutbox(home, { id: "kL", tool: "memory_remember", args: {} });
    const fd = openSync(flushLockPath(home), "wx");
    try {
      const r = await flushOutbox(home, { env, requestImpl: okReq([]) });
      expect(r.skipped).toBe(true);
      // pending untouched
      expect(
        readJsonl(pendingPath(home)).map((e: { id: string }) => e.id),
      ).toEqual(["kL"]);
    } finally {
      const { closeSync, unlinkSync } = await import("node:fs");
      closeSync(fd);
      unlinkSync(flushLockPath(home));
    }
  });

  it("retakes a stale (>60s) flush.lock", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    enqueueOutbox(home, { id: "kS", tool: "memory_remember", args: {} });
    const lock = flushLockPath(home);
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 61_000);
    utimesSync(lock, old, old);
    const calls: Call[] = [];
    const r = await flushOutbox(home, {
      env,
      requestImpl: okReq(calls),
      sweep: false,
    });
    expect(r.sent).toBe(1);
    expect(readJsonl(pendingPath(home))).toEqual([]);
  });

  it("keeps entries enqueued mid-flush (lost-enqueue race)", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    enqueueOutbox(home, { id: "first", tool: "memory_remember", args: {} });
    const req = async () => {
      // simulate a concurrent write landing while the flush is in flight
      enqueueOutbox(home, {
        id: "late",
        tool: "memory_remember",
        args: { content: "late" },
      });
      return { ok: true, status: 200, data: {} };
    };
    const r = await flushOutbox(home, { env, requestImpl: req, sweep: false });
    expect(r.sent).toBe(1);
    const pending = readJsonl(pendingPath(home));
    expect(pending.map((e: { id: string }) => e.id)).toEqual(["late"]);
  });

  it("gives up at MAX_ATTEMPTS → failed", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    const e = enqueueOutbox(home, {
      id: "k5",
      tool: "memory_remember",
      args: {},
    });
    // pretend it already failed 19 times
    const p = pendingPath(home);
    writeFileSync(p, `${JSON.stringify({ ...e, attempts: 19 })}\n`);
    const down = async () => ({
      ok: false,
      status: 0,
      unreachable: true,
      error: "down",
    });
    const r = await flushOutbox(home, { env, requestImpl: down, sweep: false });
    expect(r.failed).toBe(1);
    expect(readJsonl(pendingPath(home))).toEqual([]);
    expect(readJsonl(failedPath(home))[0].id).toBe("k5");
  });
});

describe("session sweep (W4)", () => {
  function seedSession(home: string, overrides: Record<string, unknown> = {}) {
    const s = {
      ...newSession("codex", "sess-1", "/tmp/proj"),
      turns: 5,
      ended: true,
      lastAssistant: "shipped the thing",
      ...overrides,
    };
    saveSession(home, s);
    return s;
  }

  it("enqueues exactly one checkpoint for an ended quiet session", async () => {
    const home = tmpHome();
    seedSession(home);
    const calls: Call[] = [];
    const r = await flushOutbox(home, {
      env: makeEnv(home, "x"),
      requestImpl: okReq(calls),
    });
    expect(r.sent).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].tool).toBe("memory_checkpoint");
    expect(calls[0].args.scope_type).toBe("project");
    expect(calls[0].args.scope_key).toBe("/tmp/proj");
    expect(calls[0].args.summary).toContain("会话收工（codex）");

    // second flush must not enqueue again (checkpointed flag)
    const calls2: Call[] = [];
    const r2 = await flushOutbox(home, {
      env: makeEnv(home, "x"),
      requestImpl: okReq(calls2),
    });
    expect(r2.sent).toBe(0);
    expect(calls2.length).toBe(0);
  });

  it("uses global scope when the session has no project", async () => {
    const home = tmpHome();
    seedSession(home, {
      harness: "antigravity",
      sessionId: "s-g",
      projectKey: null,
    });
    const calls: Call[] = [];
    await flushOutbox(home, {
      env: makeEnv(home, "x"),
      requestImpl: okReq(calls),
    });
    expect(calls[0].args.scope_type).toBe("global");
    expect(calls[0].args.scope_key).toBeUndefined();
  });

  it("skips sessions that are short, still active, or already wrote", async () => {
    const home = tmpHome();
    seedSession(home, { sessionId: "short", turns: 2 });
    seedSession(home, {
      sessionId: "active",
      ended: false,
      lastEventAt: new Date().toISOString(),
    });
    seedSession(home, { sessionId: "no-assistant", lastAssistant: "" });
    seedSession(home, {
      sessionId: "wrote",
      projectKey: "/tmp/wrote",
      // clearly older than the recordLastWrite below — "newer than" is strict
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const { recordLastWrite } = await import("../../harness/core/state.mjs");
    recordLastWrite(home, "/tmp/wrote");
    const calls: Call[] = [];
    await flushOutbox(home, {
      env: makeEnv(home, "x"),
      requestImpl: okReq(calls),
    });
    expect(calls.length).toBe(0);
  });

  it("deletes session files older than 7 days", async () => {
    const home = tmpHome();
    seedSession(home, {
      sessionId: "old",
      turns: 0,
      ended: true,
      lastAssistant: "",
      startedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
      lastEventAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
    });
    sweepSessions(home);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(sessionsDir(home), "codex-old.json"))).toBe(false);
  });
});
