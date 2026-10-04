// Harness hook dispatcher: normalizes each harness's payload, runs the lens /
// turn-count / wrap-up logic, and returns the exact JSON shape that harness
// expects on stdout. The CLI layer guarantees: any failure → harness-safe
// empty output, exit 0.

import { readFileSync } from "node:fs";
import { flaremoHome } from "./paths.mjs";
import { resolveProject } from "./project.mjs";
import {
  lastFlushAt,
  lastWriteFor,
  loadSession,
  newSession,
  readSnapshot,
  saveSession,
  writeSnapshot,
} from "./state.mjs";
import {
  LENS_HEADER,
  OFFLINE_SNAPSHOT_NOTE,
  UNREACHABLE_NOTICE,
  WRAP_UP_NUDGE,
} from "./texts.mjs";
import { request as defaultRequest, HOOK_TIMEOUT_MS } from "./transport.mjs";

export const HARNESSES = ["zcode", "codex", "antigravity"];

const EVENTS = {
  zcode: new Set(["session-start", "user-prompt", "stop"]),
  codex: new Set(["session-start", "user-prompt", "stop", "session-end"]),
  antigravity: new Set(["pre-invocation", "stop"]),
};

const FLUSH_STALE_MS = 5 * 60 * 1000;

export function emptyOutput(harness, event) {
  // Codex requires valid JSON for Stop; Antigravity Stop uses `decision`.
  if (harness === "antigravity" && event === "stop") return { decision: "" };
  return {};
}

/**
 * W3 decision, pure. `lastWriteAt` is the ISO timestamp of the last successful
 * ledger write for this session's project (null = none).
 */
export function decideWrapUp(
  state,
  { stopHookActive, harness, fullyIdle, terminationReason, lastWriteAt } = {},
) {
  if (stopHookActive) return false;
  if (state.nudged) return false;
  if ((state.turns ?? 0) < 4) return false;
  if (
    lastWriteAt &&
    Date.parse(lastWriteAt) > Date.parse(state.startedAt || "")
  ) {
    return false;
  }
  if (harness === "antigravity") {
    if (fullyIdle !== true) return false;
    if (terminationReason && /error|max_steps/i.test(terminationReason)) {
      return false;
    }
  }
  return true;
}

function mapFields(harness, payload, env) {
  if (harness === "antigravity") {
    const sessionId =
      payload.conversationId || env.ANTIGRAVITY_CONVERSATION_ID || "unknown";
    const dir = Array.isArray(payload.workspacePaths)
      ? payload.workspacePaths[0]
      : undefined;
    // No workspace path → project-less session: global lens, global W4 scope.
    return {
      sessionId,
      projectKey: dir ? resolveProject(dir, env) : null,
    };
  }
  const sessionId =
    payload.session_id ||
    (harness === "zcode" ? env.ZCODE_SESSION_ID : "") ||
    "unknown";
  const dir =
    payload.cwd ||
    (harness === "zcode" ? env.ZCODE_PROJECT_DIR : undefined) ||
    process.cwd();
  return { sessionId, projectKey: resolveProject(dir, env) };
}

/** L1: compile the lens, or degrade to snapshot / unreachable notice. */
async function compileLens({ harness, projectKey, env, home, requestImpl }) {
  const args = { agent: harness, max_chars: 6000 };
  if (projectKey) args.project_key = projectKey;
  const res = await requestImpl("memory_compile", args, {
    timeoutMs: HOOK_TIMEOUT_MS,
    env,
    home,
  });
  if (res.ok) {
    const payload = res.data?.system_prompt_payload;
    if (typeof payload === "string" && payload.trim()) {
      writeSnapshot(home, projectKey, payload);
      return { injected: true, text: `${LENS_HEADER}\n\n${payload}` };
    }
    return { injected: true, text: null }; // empty lens → inject nothing
  }
  if (res.unreachable) {
    const snap = readSnapshot(home, projectKey);
    return snap
      ? {
          injected: true,
          text: `${LENS_HEADER}\n\n${snap}\n${OFFLINE_SNAPSHOT_NOTE}`,
        }
      : { injected: true, text: UNREACHABLE_NOTICE };
  }
  return { injected: false, text: null };
}

function sessionStartOutput(text) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  };
}

function antigravityInjectOutput(text) {
  return { injectSteps: [{ ephemeralMessage: text }] };
}

/** Best effort: last MODEL/PLANNER_RESPONSE row in an Antigravity transcript. */
function antigravityLastAssistant(transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, "utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        row?.source === "MODEL" &&
        row?.type === "PLANNER_RESPONSE" &&
        typeof row?.content === "string" &&
        row.content.trim()
      ) {
        return row.content;
      }
    }
  } catch {}
  return "";
}

/**
 * @returns {Promise<{output: object, spawnFlush: boolean}>}
 */
export async function handleHook(
  harness,
  event,
  payload = {},
  {
    env = process.env,
    home = flaremoHome(env),
    requestImpl = defaultRequest,
    now = Date.now(),
  } = {},
) {
  if (!HARNESSES.includes(harness) || !EVENTS[harness]?.has(event)) {
    return { output: emptyOutput(harness, event), spawnFlush: false };
  }

  const { sessionId, projectKey } = mapFields(harness, payload, env);
  // "unknown" is a fallback identity shared by every unidentifiable session —
  // never persist it, or one session's lensInjected/nudged flags would leak
  // into all the others. Every call behaves as a fresh session.
  const stateless = sessionId === "unknown";
  const state = stateless
    ? newSession(harness, sessionId, projectKey)
    : (loadSession(home, harness, sessionId) ??
      newSession(harness, sessionId, projectKey));
  if (projectKey !== undefined && projectKey !== state.projectKey) {
    state.projectKey = projectKey;
  }
  state.lastEventAt = new Date(now).toISOString();

  let output = emptyOutput(harness, event);
  let spawnFlush = false;

  try {
    switch (event) {
      case "session-start": {
        const isCompactReinject =
          harness === "codex" && payload.source === "compact";
        if (!state.lensInjected || isCompactReinject) {
          const lens = await compileLens({
            harness,
            projectKey,
            env,
            home,
            requestImpl,
          });
          if (lens.injected) state.lensInjected = true;
          if (lens.text) output = sessionStartOutput(lens.text);
        }
        break;
      }
      case "user-prompt": {
        state.turns += 1;
        break;
      }
      case "pre-invocation": {
        if (payload.invocationNum === 0) state.turns += 1;
        if (!state.lensInjected) {
          const lens = await compileLens({
            harness,
            projectKey,
            env,
            home,
            requestImpl,
          });
          if (lens.injected) state.lensInjected = true;
          if (lens.text) output = antigravityInjectOutput(lens.text);
        }
        break;
      }
      case "stop": {
        if (harness === "antigravity") {
          state.lastAssistant =
            antigravityLastAssistant(payload.transcriptPath) ||
            (typeof payload.last_assistant_message === "string"
              ? payload.last_assistant_message
              : "");
        } else if (typeof payload.last_assistant_message === "string") {
          state.lastAssistant = payload.last_assistant_message;
        }
        const nudge = decideWrapUp(state, {
          stopHookActive: payload.stop_hook_active === true,
          harness,
          fullyIdle: payload.fullyIdle,
          terminationReason: payload.terminationReason,
          lastWriteAt: lastWriteFor(home, state.projectKey),
        });
        if (nudge) {
          state.nudged = true;
          output =
            harness === "antigravity"
              ? { decision: "continue", reason: WRAP_UP_NUDGE }
              : { decision: "block", reason: WRAP_UP_NUDGE };
        }
        break;
      }
      case "session-end": {
        state.ended = true;
        spawnFlush = true;
        break;
      }
    }
  } finally {
    if (!stateless) {
      try {
        saveSession(home, state);
      } catch {}
    }
  }

  // Best-effort background flush when the stamp is stale (>5min) or the
  // session just ended.
  const stamp = lastFlushAt(home);
  if (!spawnFlush && (stamp === null || now - stamp > FLUSH_STALE_MS)) {
    spawnFlush = true;
  }
  return { output, spawnFlush };
}
