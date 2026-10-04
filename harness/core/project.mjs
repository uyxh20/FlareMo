// Project identity: one resolver used everywhere a project key is needed.
// Order: FLAREMO_PROJECT env > git toplevel > the directory itself.
// (Git-remote identity is deferred to P1 — existing ledger rows are keyed by
// absolute paths.)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export function resolveProject(dir, env = process.env) {
  if (env.FLAREMO_PROJECT) return env.FLAREMO_PROJECT;
  if (!dir) return null;
  dir = String(dir).replace(/\/+$/, "") || dir;
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel"],
      {
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const top = out.toString().trim();
    // Whitelist-mode env repos (e.g. ~/code ignoring `/*` except AGENTS.md)
    // claim every subdir as their toplevel; if the dir is ignored by that
    // repo, it is not really part of the project — keep the dir itself.
    if (top && top !== dir && isIgnoredByRepo(dir)) return dir;
    if (top) return top;
  } catch {
    // Not a repo (or git missing/slow) — the dir itself is the key.
  }
  return dir;
}

/** True when `dir` is ignored by the repo containing it (check-ignore exit 0). */
function isIgnoredByRepo(dir) {
  try {
    execFileSync("git", ["-C", dir, "check-ignore", "-q", "."], {
      timeout: 1000,
      stdio: "ignore",
    });
    return true;
  } catch {
    // 1 = not ignored, 128 = not a repo / error → keep the toplevel.
    return false;
  }
}

export function projectAnchor(projectKey) {
  return createHash("sha256")
    .update(projectKey ?? "global")
    .digest("hex")
    .slice(0, 16);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
