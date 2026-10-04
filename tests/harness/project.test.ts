import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS modules without types
import { resolveProject } from "../../harness/core/project.mjs";
import { tmpHome } from "./helpers";

function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
}

describe("resolveProject", () => {
  it("FLAREMO_PROJECT wins over everything", () => {
    expect(resolveProject("/tmp/x", { FLAREMO_PROJECT: "env-proj" })).toBe(
      "env-proj",
    );
  });

  it("resolves a normal subdir to its repo root", () => {
    const repo = join(tmpHome(), "repo");
    const src = join(repo, "src", "deep");
    gitInit(repo);
    mkdirSync(src, { recursive: true });
    // git reports the realpath (/var → /private/var on macOS)
    expect(resolveProject(src, {})).toBe(realpathSync(repo));
  });

  it("a dir ignored by a whitelist-mode parent repo resolves to itself", () => {
    // Mimic ~/code: a repo whose .gitignore ignores /* except a whitelist —
    // subdirs inside it are NOT part of that repo's project.
    const root = join(tmpHome(), "code");
    gitInit(root);
    writeFileSync(join(root, ".gitignore"), "/*\n!keep.md\n");
    const fm = join(root, "fm");
    mkdirSync(fm, { recursive: true });
    expect(resolveProject(fm, {})).toBe(fm);
  });

  it("a real nested repo inside an ignored dir resolves to the nested repo", () => {
    const root = join(tmpHome(), "code");
    gitInit(root);
    writeFileSync(join(root, ".gitignore"), "/*\n!keep.md\n");
    const app = join(root, "fm", "app");
    gitInit(app);
    expect(resolveProject(app, {})).toBe(realpathSync(app));
  });

  it("strips trailing slashes before resolving", () => {
    const repo = join(tmpHome(), "repo");
    gitInit(repo);
    expect(resolveProject(`${repo}/`, {})).toBe(realpathSync(repo));
  });

  it("falls back to the dir itself outside any repo", () => {
    const dir = join(tmpHome(), "plain");
    mkdirSync(dir, { recursive: true });
    expect(resolveProject(dir, {})).toBe(dir);
  });
});
