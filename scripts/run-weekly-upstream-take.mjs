#!/usr/bin/env node

// Git-backed runner for the weekly deterministic take. The workflow calls
// this after fetching the upstream tag. It never merges a pull request.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertReleaseTag,
  classifyPath,
  renderPullRequestBody,
  shouldOpenPullRequest,
  summarizeDecisions,
} from "./take-upstream-files.mjs";

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trimEnd();
}

function blob(ref, path) {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function looksBinary(content) {
  return content?.includes("\0") ?? false;
}

function threeWay(ours, base, theirs) {
  const dir = join(
    tmpdir(),
    `flaremo-upstream-take-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const oursPath = join(dir, "ours");
  const basePath = join(dir, "base");
  const theirsPath = join(dir, "theirs");
  writeFileSync(oursPath, ours ?? "");
  writeFileSync(basePath, base ?? "");
  writeFileSync(theirsPath, theirs ?? "");
  try {
    const result = execFileSync(
      "git",
      ["merge-file", "-p", oursPath, basePath, theirsPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { clean: true, result };
  } catch (error) {
    if (error && typeof error.status === "number" && error.status > 0) {
      return { clean: false, result: null };
    }
    throw error;
  }
}

export function classifyRepository({ oursRef, baseRef, theirsRef }) {
  const names = new Set([
    ...git(["ls-tree", "-r", "--name-only", oursRef])
      .split("\n")
      .filter(Boolean),
    ...git(["ls-tree", "-r", "--name-only", theirsRef])
      .split("\n")
      .filter(Boolean),
  ]);
  const decisions = [];
  for (const path of [...names].sort()) {
    const ours = blob(oursRef, path);
    const base = blob(baseRef, path);
    const theirs = blob(theirsRef, path);
    if (ours === theirs) {
      decisions.push(classifyPath({ path, ours, base, theirs }));
      continue;
    }
    let three;
    const bothChanged = ours !== base && theirs !== base;
    if (bothChanged) {
      if (looksBinary(ours) || looksBinary(theirs)) {
        three = { clean: false, result: null };
      } else {
        three = threeWay(ours, base, theirs);
      }
    }
    decisions.push(classifyPath({ path, ours, base, theirs, threeWay: three }));
  }
  return decisions;
}

export function applyTakes({ theirsRef, summary }) {
  for (const path of summary.taken) {
    mkdirSync(dirname(path), { recursive: true });
    execFileSync("git", ["checkout", theirsRef, "--", path], {
      stdio: "inherit",
    });
  }
  for (const path of summary.deleted) {
    execFileSync("git", ["rm", "-f", "--", path], { stdio: "inherit" });
  }
}

function parseArgs(argv) {
  const args = {
    oursRef: "HEAD",
    apply: false,
    report: "",
    body: "",
    currentVersion: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--theirs") args.theirsRef = argv[++i];
    else if (arg === "--base") args.baseRef = argv[++i];
    else if (arg === "--ours") args.oursRef = argv[++i];
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--body") args.body = argv[++i];
    else if (arg === "--current-version") args.currentVersion = argv[++i];
    else if (arg === "--target-version") args.targetVersion = argv[++i];
  }
  if (!args.theirsRef || !args.baseRef || !args.targetVersion) {
    throw new Error(
      "Usage: run-weekly-upstream-take --theirs <ref> --base <ref> --target-version vX.Y.Z [--apply]",
    );
  }
  assertReleaseTag(args.targetVersion);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const decisions = classifyRepository({
    oursRef: args.oursRef,
    baseRef: args.baseRef,
    theirsRef: args.theirsRef,
  });
  const summary = summarizeDecisions(decisions);
  const report = {
    openPullRequest: shouldOpenPullRequest(summary),
    summary,
    decisions: decisions.filter((decision) => decision.action !== "identical"),
  };
  if (args.report) {
    mkdirSync(dirname(args.report), { recursive: true });
    writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.body) {
    mkdirSync(dirname(args.body), { recursive: true });
    writeFileSync(
      args.body,
      renderPullRequestBody({
        targetVersion: args.targetVersion,
        currentVersion: args.currentVersion || "unknown",
        summary,
      }),
    );
  }
  if (args.apply && report.openPullRequest) {
    applyTakes({ theirsRef: args.theirsRef, summary });
  }
  process.stdout.write(
    `${JSON.stringify({ openPullRequest: report.openPullRequest, summary }, null, 2)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
