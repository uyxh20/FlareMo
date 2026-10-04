// Local state: session files, last-write markers, lens snapshots, flush stamp.
// All writes go through temp-file + rename so a killed process never leaves a
// torn file behind. No locking: single-writer CLI + atomic rename is enough.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  cacheDir,
  lastFlushPath,
  lastWritePath,
  sessionsDir,
} from "./paths.mjs";
import { projectAnchor } from "./project.mjs";

export function atomicWriteFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

export function atomicWriteJson(path, obj) {
  atomicWriteFile(path, `${JSON.stringify(obj, null, 2)}\n`);
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

export function appendJsonl(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(obj)}\n`, "utf-8");
}

export function readJsonl(path) {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// --- session state ---------------------------------------------------------

const SESSION_SAFE = /[^a-zA-Z0-9_-]/g;

export function sessionFilePath(home, harness, sessionId) {
  const id = String(sessionId || "unknown")
    .replace(SESSION_SAFE, "_")
    .slice(0, 128);
  return join(sessionsDir(home), `${harness}-${id}.json`);
}

export function loadSession(home, harness, sessionId) {
  return readJson(sessionFilePath(home, harness, sessionId));
}

export function saveSession(home, session) {
  atomicWriteJson(
    sessionFilePath(home, session.harness, session.sessionId),
    session,
  );
}

export function newSession(harness, sessionId, projectKey) {
  const now = new Date().toISOString();
  return {
    harness,
    sessionId: sessionId || "unknown",
    projectKey: projectKey ?? null,
    startedAt: now,
    lastEventAt: now,
    turns: 0,
    lensInjected: false,
    nudged: false,
    lastAssistant: "",
    ended: false,
    checkpointed: false,
  };
}

export function listSessions(home) {
  const dir = sessionsDir(home);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => ({ path: join(dir, n), state: readJson(join(dir, n)) }))
    .filter((e) => e.state && typeof e.state === "object");
}

export function deleteFile(path) {
  try {
    unlinkSync(path);
  } catch {}
}

export function fileAgeMs(path, now = Date.now()) {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// --- last-write markers ----------------------------------------------------
// last-write.json is a map: { <projectKey>: { at: <ISO> } } — one entry per
// project so a write in project A never masks "no write yet" in project B.

export function readLastWrites(home) {
  const data = readJson(lastWritePath(home), {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

export function recordLastWrite(home, projectKey, at = new Date()) {
  const writes = readLastWrites(home);
  writes[projectKey ?? ""] = { at: at.toISOString() };
  atomicWriteJson(lastWritePath(home), writes);
}

/** ISO string of the last successful write for this project, or null. */
export function lastWriteFor(home, projectKey) {
  return readLastWrites(home)[projectKey ?? ""]?.at ?? null;
}

// --- lens snapshots ----------------------------------------------------------

export function snapshotPath(home, projectKey) {
  return join(cacheDir(home), `${projectAnchor(projectKey)}.md`);
}

export function readSnapshot(home, projectKey) {
  try {
    const text = readFileSync(snapshotPath(home, projectKey), "utf-8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(home, projectKey, text) {
  try {
    atomicWriteFile(snapshotPath(home, projectKey), text);
  } catch {}
}

// --- flush stamp -------------------------------------------------------------

export function lastFlushAt(home) {
  try {
    const text = readFileSync(lastFlushPath(home), "utf-8").trim();
    const t = Date.parse(text);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

export function touchLastFlush(home, now = new Date()) {
  try {
    atomicWriteFile(lastFlushPath(home), now.toISOString());
  } catch {}
}

export { existsSync, mkdirSync };
