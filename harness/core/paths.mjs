// Filesystem layout for the local FlareMo state home and harness homes.
// Everything is overridable through env so tests never touch real homes.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_URL = "http://127.0.0.1:8787";

/** Repo checkout this code lives in (…/harness/core/paths.mjs → checkout root). */
export function checkoutRoot() {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export function flaremoHome(env = process.env) {
  return env.FLAREMO_HOME || join(homedir(), ".flaremo");
}

export function zcodeHome(env = process.env) {
  return env.ZCODE_HOME || join(homedir(), ".zcode");
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

export function geminiHome(env = process.env) {
  return env.GEMINI_HOME || join(homedir(), ".gemini");
}

export function piHome(env = process.env) {
  return env.PI_HOME || join(homedir(), ".pi", "agent");
}

export function agentsHome(env = process.env) {
  return env.AGENTS_HOME || join(homedir(), ".agents");
}

export function flaremoBinDir(env = process.env) {
  return env.FLAREMO_BIN_DIR || join(homedir(), ".local", "bin");
}

export function sessionsDir(home) {
  return join(home, "sessions");
}

export function outboxDir(home) {
  return join(home, "outbox");
}

export function pendingPath(home) {
  return join(outboxDir(home), "pending.jsonl");
}

export function failedPath(home) {
  return join(outboxDir(home), "failed.jsonl");
}

export function flushLockPath(home) {
  return join(outboxDir(home), "flush.lock");
}

export function cacheDir(home) {
  return join(home, "cache");
}

export function backupDir(home) {
  return join(home, "backup");
}

export function credentialsPath(home) {
  return join(home, "credentials");
}

export function hookWrapperPath(home) {
  return join(home, "bin", "flaremo-hook");
}

export function lastWritePath(home) {
  return join(home, "last-write.json");
}

export function lastFlushPath(home) {
  return join(home, "last-flush");
}
