// Write-ahead outbox: remember/checkpoint calls that can't reach the ledger
// land here as JSONL lines and get retried by the next flush. No locks —
// pending.jsonl is rewritten via temp+rename at the end of a flush pass.

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import {
  failedPath,
  flaremoHome,
  flushLockPath,
  outboxDir,
  pendingPath,
} from "./paths.mjs";
import {
  appendJsonl,
  atomicWriteFile,
  deleteFile,
  fileAgeMs,
  lastWriteFor,
  listSessions,
  readJsonl,
  saveSession,
  touchLastFlush,
} from "./state.mjs";
import { request as defaultRequest } from "./transport.mjs";

export const MAX_ATTEMPTS = 20;
const SESSION_STALE_MS = 30 * 60 * 1000;
const SESSION_DELETE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 60 * 1000;

export function enqueueOutbox(home, { id, tool, args }) {
  const entry = {
    id: String(id || `outbox:${randomUUID()}`).slice(0, 128),
    tool,
    args: args && typeof args === "object" ? { ...args } : {},
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  // Replaying a write whose first attempt timed out but committed must return
  // the original row, not create a twin — the entry id doubles as the key.
  if (
    entry.tool === "memory_remember" &&
    typeof entry.args.idempotency_key !== "string"
  ) {
    entry.args.idempotency_key = entry.id;
  }
  appendJsonl(pendingPath(home), entry);
  return entry;
}

/**
 * Best-effort single-flusher lock: `wx` create, stale locks (>60s) are
 * presumed dead and retaken. Returns a release fn, or null when another
 * flush holds a fresh lock.
 */
function acquireFlushLock(home) {
  const path = flushLockPath(home);
  const take = () => {
    const fd = openSync(path, "wx");
    return () => {
      try {
        closeSync(fd);
      } catch {}
      deleteFile(path);
    };
  };
  mkdirSync(outboxDir(home), { recursive: true });
  try {
    return take();
  } catch {
    // EEXIST: someone holds it — or left a stale one behind.
  }
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age <= LOCK_STALE_MS) return null;
    unlinkSync(path);
  } catch {
    return null; // vanished between checks, or unreadable — next run retries
  }
  try {
    return take();
  } catch {
    return null; // lost the retake race — the winner flushes
  }
}

/**
 * W4 sweep: finished sessions that never wrote anything get one checkpoint
 * enqueued from their last assistant message. Purely local — never touches the
 * network; also prunes session files older than 7 days.
 */
export function sweepSessions(home, { now = Date.now() } = {}) {
  for (const { path, state } of listSessions(home)) {
    const lastActivity = Date.parse(state.lastEventAt || state.startedAt || "");
    const age = Number.isNaN(lastActivity)
      ? fileAgeMs(path, now)
      : now - lastActivity;
    if (age !== null && age > SESSION_DELETE_MS) {
      deleteFile(path);
      continue;
    }
    const idle =
      state.ended === true || (age !== null && age > SESSION_STALE_MS);
    const wroteAt = lastWriteFor(home, state.projectKey);
    const wroteAfterStart =
      wroteAt !== null &&
      Date.parse(wroteAt) > Date.parse(state.startedAt || "");
    if (
      state.checkpointed ||
      (state.turns ?? 0) < 3 ||
      !idle ||
      !state.lastAssistant ||
      wroteAfterStart
    ) {
      continue;
    }
    const projectKey = state.projectKey ?? null;
    const summary = `会话收工（${state.harness}）：${state.lastAssistant.slice(0, 1500)}`;
    enqueueOutbox(home, {
      id: `ckpt:${state.harness}:${state.sessionId}`,
      tool: "memory_checkpoint",
      args: {
        agent: state.harness,
        project_key: projectKey ?? undefined,
        scope_type: projectKey ? "project" : "global",
        scope_key: projectKey ?? undefined,
        summary,
        items: [
          { content: summary, type: "semantic", kind: "fact", importance: 50 },
        ],
      },
    });
    state.checkpointed = true;
    saveSession(home, state);
  }
}

/**
 * Flush pending entries. drop on success; move to failed.jsonl on 4xx or tool
 * error; keep on network/5xx (attempts++, give up at MAX_ATTEMPTS → failed).
 * `budgetMs` caps the whole pass (used for the silent end-of-command flush).
 */
export async function flushOutbox(
  home = flaremoHome(),
  {
    env = process.env,
    requestImpl = defaultRequest,
    budgetMs = 30_000,
    timeoutMs = 8_000,
    sweep = true,
    now = Date.now,
  } = {},
) {
  const release = acquireFlushLock(home);
  if (!release) return { skipped: true };

  try {
    const started = now();
    if (sweep) {
      try {
        sweepSessions(home);
      } catch {}
    }

    const pending = readJsonl(pendingPath(home));
    const seenIds = new Set(pending.map((e) => e.id));
    const keep = [];
    const sent = [];
    const failed = [];
    for (const entry of pending) {
      const remainingMs = budgetMs - (now() - started);
      if (remainingMs <= 0) {
        keep.push(entry);
        continue;
      }
      const res = await requestImpl(entry.tool, entry.args, {
        timeoutMs: Math.min(timeoutMs, remainingMs),
        env,
        home,
      });
      if (res.ok) {
        sent.push(entry);
      } else if (res.toolError || (res.status >= 400 && res.status < 500)) {
        failed.push({
          ...entry,
          failedAt: new Date().toISOString(),
          error: res.error,
        });
      } else {
        entry.attempts = (entry.attempts ?? 0) + 1;
        if (entry.attempts >= MAX_ATTEMPTS) {
          failed.push({
            ...entry,
            failedAt: new Date().toISOString(),
            error: res.error ?? "max attempts",
          });
        } else {
          keep.push(entry);
        }
      }
    }

    // Entries enqueued while this pass was in flight aren't in `pending` —
    // re-read the file and carry them over so the rewrite can't lose them.
    for (const late of readJsonl(pendingPath(home))) {
      if (!seenIds.has(late.id)) {
        seenIds.add(late.id);
        keep.push(late);
      }
    }

    if (pending.length > 0 || keep.length > 0) {
      atomicWriteFile(
        pendingPath(home),
        keep.map((e) => JSON.stringify(e)).join("\n") +
          (keep.length ? "\n" : ""),
      );
    }
    for (const entry of failed) {
      appendJsonl(failedPath(home), entry);
    }
    touchLastFlush(home);
    return { sent: sent.length, kept: keep.length, failed: failed.length };
  } finally {
    release();
  }
}
