import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS modules without types
import { decideWrapUp, handleHook } from "../../harness/core/hooks.mjs";
// @ts-expect-error plain-JS modules without types
import {
  LENS_HEADER,
  UNREACHABLE_NOTICE,
  WRAP_UP_NUDGE,
} from "../../harness/core/texts.mjs";
import { fakeMcpServer, makeEnv, runCli, tmpHome } from "./helpers";

const PROJ = mkdtempSync(join(tmpdir(), "flaremo-proj-"));

function lensOk(payload = "LENS BODY") {
  return async () => ({
    ok: true,
    status: 200,
    data: { system_prompt_payload: payload },
  });
}

function unreachable() {
  return async () => ({
    ok: false,
    status: 0,
    unreachable: true,
    error: "down",
  });
}

function parseStdout(stdout: string) {
  return JSON.parse(stdout.trim().split("\n").pop() ?? "");
}

describe("hook output shapes (subprocess)", () => {
  it("zcode session-start injects lens via additionalContext", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer({
      memory_compile: { system_prompt_payload: "LENS BODY" },
    });
    try {
      const env = makeEnv(home, srv.url);
      const { stdout, status } = await runCli(
        ["hook", "zcode", "session-start"],
        {
          env,
          input: JSON.stringify({ session_id: "s1", cwd: PROJ }),
        },
      );
      expect(status).toBe(0);
      const out = parseStdout(stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(out.hookSpecificOutput.additionalContext).toContain(LENS_HEADER);
      expect(out.hookSpecificOutput.additionalContext).toContain("LENS BODY");
      expect(srv.calls[0].tool).toBe("memory_compile");
      expect(srv.calls[0].args.agent).toBe("zcode");
      expect(srv.calls[0].args.project_key).toBe(PROJ);
    } finally {
      await srv.close();
    }
  });

  it("zcode lens is injected once per session", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer({
      memory_compile: { system_prompt_payload: "LENS BODY" },
    });
    try {
      const env = makeEnv(home, srv.url);
      const payload = JSON.stringify({ session_id: "s2", cwd: PROJ });
      await runCli(["hook", "zcode", "session-start"], { env, input: payload });
      const second = await runCli(["hook", "zcode", "session-start"], {
        env,
        input: payload,
      });
      expect(parseStdout(second.stdout)).toEqual({});
      expect(srv.calls.length).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it("codex source=compact re-injects the lens", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer({
      memory_compile: { system_prompt_payload: "LENS BODY" },
    });
    try {
      const env = makeEnv(home, srv.url);
      await runCli(["hook", "codex", "session-start"], {
        env,
        input: JSON.stringify({
          session_id: "c1",
          cwd: PROJ,
          source: "startup",
        }),
      });
      const again = await runCli(["hook", "codex", "session-start"], {
        env,
        input: JSON.stringify({
          session_id: "c1",
          cwd: PROJ,
          source: "compact",
        }),
      });
      const out = parseStdout(again.stdout);
      expect(out.hookSpecificOutput.additionalContext).toContain("LENS BODY");
      expect(srv.calls.length).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it("codex session-end outputs empty object", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    try {
      const env = makeEnv(home, srv.url);
      const { stdout, status } = await runCli(
        ["hook", "codex", "session-end"],
        {
          env,
          input: JSON.stringify({ session_id: "c9", cwd: PROJ }),
        },
      );
      expect(status).toBe(0);
      expect(parseStdout(stdout)).toEqual({});
    } finally {
      await srv.close();
    }
  });

  it("antigravity pre-invocation injects via injectSteps", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer({
      memory_compile: { system_prompt_payload: "LENS BODY" },
    });
    try {
      const env = makeEnv(home, srv.url);
      const { stdout } = await runCli(
        ["hook", "antigravity", "pre-invocation"],
        {
          env,
          input: JSON.stringify({
            conversationId: "a1",
            workspacePaths: [PROJ],
            invocationNum: 0,
          }),
        },
      );
      const out = parseStdout(stdout);
      expect(out.injectSteps[0].ephemeralMessage).toContain("LENS BODY");
    } finally {
      await srv.close();
    }
  });

  it("antigravity without workspacePaths compiles a global lens", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer({
      memory_compile: { system_prompt_payload: "GLOBAL LENS" },
    });
    try {
      const env = makeEnv(home, srv.url);
      const { stdout } = await runCli(
        ["hook", "antigravity", "pre-invocation"],
        {
          env,
          input: JSON.stringify({ conversationId: "a2", invocationNum: 0 }),
        },
      );
      expect(parseStdout(stdout).injectSteps[0].ephemeralMessage).toContain(
        "GLOBAL LENS",
      );
      expect(srv.calls[0].args.project_key).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("unreachable without snapshot emits UNREACHABLE_NOTICE", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1"); // closed port
    const { stdout, status } = await runCli(
      ["hook", "zcode", "session-start"],
      {
        env,
        input: JSON.stringify({ session_id: "s3", cwd: PROJ }),
      },
    );
    expect(status).toBe(0);
    expect(parseStdout(stdout).hookSpecificOutput.additionalContext).toContain(
      UNREACHABLE_NOTICE.slice(0, 20),
    );
  });

  it("unreachable with snapshot serves snapshot + offline note", async () => {
    const home = tmpHome();
    const anchor = createHash("sha256").update(PROJ).digest("hex").slice(0, 16);
    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(join(home, "cache", `${anchor}.md`), "SNAPSHOT BODY");
    const env = makeEnv(home, "http://127.0.0.1:1");
    const { stdout } = await runCli(["hook", "zcode", "session-start"], {
      env,
      input: JSON.stringify({ session_id: "s4", cwd: PROJ }),
    });
    const ctx = parseStdout(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("SNAPSHOT BODY");
    expect(ctx).toContain("本地快照");
  });

  it("empty lens injects nothing", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer({
      memory_compile: { system_prompt_payload: "" },
    });
    try {
      const env = makeEnv(home, srv.url);
      const { stdout } = await runCli(["hook", "zcode", "session-start"], {
        env,
        input: JSON.stringify({ session_id: "s5", cwd: PROJ }),
      });
      expect(parseStdout(stdout)).toEqual({});
    } finally {
      await srv.close();
    }
  });

  it("garbage stdin → valid empty output, exit 0", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    try {
      const env = makeEnv(home, srv.url);
      const { stdout, status } = await runCli(["hook", "codex", "stop"], {
        env,
        input: "this is not json at all",
      });
      expect(status).toBe(0);
      expect(parseStdout(stdout)).toEqual({});
      const agy = await runCli(["hook", "antigravity", "stop"], {
        env,
        input: "%%%",
      });
      expect(parseStdout(agy.stdout)).toEqual({ decision: "" });
    } finally {
      await srv.close();
    }
  });

  it("zcode stop nudges once after >=4 turns", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    try {
      const env = makeEnv(home, srv.url);
      const payload = JSON.stringify({ session_id: "s6", cwd: PROJ });
      for (let i = 0; i < 4; i++) {
        await runCli(["hook", "zcode", "user-prompt"], { env, input: payload });
      }
      const stop = await runCli(["hook", "zcode", "stop"], {
        env,
        input: JSON.stringify({
          session_id: "s6",
          cwd: PROJ,
          last_assistant_message: "all done",
        }),
      });
      const out = parseStdout(stop.stdout);
      expect(out.decision).toBe("block");
      expect(out.reason).toBe(WRAP_UP_NUDGE);

      // second stop in the same session does not nudge again
      const stop2 = await runCli(["hook", "zcode", "stop"], {
        env,
        input: JSON.stringify({ session_id: "s6", cwd: PROJ }),
      });
      expect(parseStdout(stop2.stdout)).toEqual({});
    } finally {
      await srv.close();
    }
  });

  it("stop_hook_active suppresses the nudge", async () => {
    const home = tmpHome();
    const srv = await fakeMcpServer();
    try {
      const env = makeEnv(home, srv.url);
      const payload = JSON.stringify({ session_id: "s7", cwd: PROJ });
      for (let i = 0; i < 4; i++) {
        await runCli(["hook", "zcode", "user-prompt"], { env, input: payload });
      }
      const stop = await runCli(["hook", "zcode", "stop"], {
        env,
        input: JSON.stringify({
          session_id: "s7",
          cwd: PROJ,
          stop_hook_active: true,
        }),
      });
      expect(parseStdout(stop.stdout)).toEqual({});
    } finally {
      await srv.close();
    }
  });
});

describe("handleHook in-process", () => {
  it("counts turns only on invocationNum=0 for antigravity", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    const req = lensOk("X");
    await handleHook(
      "antigravity",
      "pre-invocation",
      { conversationId: "a", workspacePaths: [PROJ], invocationNum: 0 },
      { env, home, requestImpl: req },
    );
    await handleHook(
      "antigravity",
      "pre-invocation",
      { conversationId: "a", workspacePaths: [PROJ], invocationNum: 5 },
      { env, home, requestImpl: req },
    );
    const { loadSession } = await import("../../harness/core/state.mjs");
    const s = loadSession(home, "antigravity", "a");
    expect(s.turns).toBe(1);
  });

  it('sessionId "unknown" is stateless: lens re-injects, nothing is saved', async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    const req = lensOk("X");
    // No session_id in payload and no ZCODE_SESSION_ID in env → "unknown"
    const envNoSid = { ...env };
    delete envNoSid.ZCODE_SESSION_ID;
    const first = await handleHook(
      "zcode",
      "session-start",
      { cwd: PROJ },
      { env: envNoSid, home, requestImpl: req },
    );
    expect(first.output.hookSpecificOutput.additionalContext).toContain("X");
    // second session-start injects again — no lensInjected flag persists
    const second = await handleHook(
      "zcode",
      "session-start",
      { cwd: PROJ },
      { env: envNoSid, home, requestImpl: req },
    );
    expect(second.output.hookSpecificOutput.additionalContext).toContain("X");
    const { sessionsDir } = await import("../../harness/core/paths.mjs");
    const { readdirSync, existsSync } = await import("node:fs");
    expect(
      existsSync(sessionsDir(home)) ? readdirSync(sessionsDir(home)) : [],
    ).toEqual([]);
  });

  it("a ledger write inside the session suppresses the nudge", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    const req = unreachable();
    const { recordLastWrite } = await import("../../harness/core/state.mjs");
    for (let i = 0; i < 4; i++) {
      await handleHook(
        "zcode",
        "user-prompt",
        { session_id: "w1", cwd: PROJ },
        { env, home, requestImpl: req },
      );
    }
    recordLastWrite(home, PROJ);
    const { output } = await handleHook(
      "zcode",
      "stop",
      { session_id: "w1", cwd: PROJ },
      { env, home, requestImpl: req },
    );
    expect(output).toEqual({});
  });
});

describe("decideWrapUp truth table", () => {
  const base = {
    turns: 4,
    nudged: false,
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
  };

  it("nudges a long quiet session", () => {
    expect(
      decideWrapUp(base, {
        stopHookActive: false,
        harness: "zcode",
        lastWriteAt: null,
      }),
    ).toBe(true);
  });

  it("never when stop_hook_active / already nudged / too short / recent write", () => {
    expect(decideWrapUp(base, { stopHookActive: true, harness: "zcode" })).toBe(
      false,
    );
    expect(decideWrapUp({ ...base, nudged: true }, { harness: "zcode" })).toBe(
      false,
    );
    expect(decideWrapUp({ ...base, turns: 3 }, { harness: "zcode" })).toBe(
      false,
    );
    expect(
      decideWrapUp(base, {
        harness: "codex",
        lastWriteAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("lastWrite before session start does not suppress", () => {
    expect(
      decideWrapUp(base, {
        harness: "zcode",
        lastWriteAt: new Date(Date.now() - 7200_000).toISOString(),
      }),
    ).toBe(true);
  });

  it("antigravity requires fullyIdle and a clean terminationReason", () => {
    expect(
      decideWrapUp(base, { harness: "antigravity", fullyIdle: true }),
    ).toBe(true);
    expect(
      decideWrapUp(base, { harness: "antigravity", fullyIdle: false }),
    ).toBe(false);
    expect(
      decideWrapUp(base, {
        harness: "antigravity",
        fullyIdle: true,
        terminationReason: "error",
      }),
    ).toBe(false);
    expect(
      decideWrapUp(base, {
        harness: "antigravity",
        fullyIdle: true,
        terminationReason: "max_steps",
      }),
    ).toBe(false);
    expect(
      decideWrapUp(base, {
        harness: "antigravity",
        fullyIdle: true,
        terminationReason: "user_exit",
      }),
    ).toBe(true);
  });

  it("antigravity stop output uses decision:continue", async () => {
    const home = tmpHome();
    const env = makeEnv(home, "http://127.0.0.1:1");
    const req = unreachable();
    const transcript = join(home, "transcript_full.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ source: "USER", type: "MESSAGE", content: "hi" }),
        JSON.stringify({
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          content: "final answer",
        }),
      ].join("\n"),
    );
    for (let i = 0; i < 4; i++) {
      await handleHook(
        "antigravity",
        "pre-invocation",
        { conversationId: "a3", workspacePaths: [PROJ], invocationNum: 0 },
        { env, home, requestImpl: req },
      );
    }
    const { output } = await handleHook(
      "antigravity",
      "stop",
      { conversationId: "a3", fullyIdle: true, transcriptPath: transcript },
      { env, home, requestImpl: req },
    );
    expect(output.decision).toBe("continue");
    expect(output.reason).toBe(WRAP_UP_NUDGE);
    const { loadSession } = await import("../../harness/core/state.mjs");
    expect(loadSession(home, "antigravity", "a3").lastAssistant).toBe(
      "final answer",
    );
  });
});
