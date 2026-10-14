import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keeps docs/fork-customizations.md honest (fork-owned). Its table "Upstream
// files with a hook-in" must name exactly the upstream files this checkout
// changes: a file the fork edits without a row fails, and so does a row for a
// file that is back to upstream.
//
// "Upstream files" are the ones in upstream-manifest.txt: every path upstream
// shipped at the commit main last merged, with its git blob hash. A file counts
// as changed when its bytes differ from that blob, or when it is gone. That
// needs no upstream remote and no git history, so it works in a shallow clone.
//
// After merging a new upstream release, regenerate the manifest from that
// release (an upstream remote must be fetched), then fix the table:
//   FORK_UPSTREAM_MANIFEST_WRITE=upstream/main pnpm exec vitest run packages/domain/src/fork/upstream-hookins.test.ts

const repo = (path: string) =>
  fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

const MANIFEST = repo("packages/domain/src/fork/upstream-manifest.txt");
const DOC = repo("docs/fork-customizations.md");
const TABLE_HEADING = "## Upstream files with a hook-in";

/** git's blob id for a file's bytes, shortened like the manifest. */
function blobId(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex")
    .slice(0, 12);
}

function writeManifest(ref: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo("."), encoding: "utf8" });
  const commit = git("rev-parse", `${ref}^{commit}`).trim();
  const lines = git("ls-tree", "-r", "--full-tree", commit)
    .trim()
    .split("\n")
    .flatMap((line) => {
      // "<mode> blob <sha>\t<path>"; submodules and symlinks are skipped.
      const [, sha, path] =
        /^100\d{3} blob ([0-9a-f]{40})\t(.+)$/.exec(line) ?? [];
      return sha && path ? [`${sha.slice(0, 12)} ${path}`] : [];
    });
  writeFileSync(
    MANIFEST,
    `# upstream realchendahuang/FlareMo ${commit}\n${lines.join("\n")}\n`,
  );
}

function readManifest(): Array<{ blob: string; path: string }> {
  return readFileSync(MANIFEST, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const space = line.indexOf(" ");
      return { blob: line.slice(0, space), path: line.slice(space + 1) };
    });
}

function changedUpstreamFiles(): string[] {
  return readManifest()
    .filter(({ blob, path }) => {
      const file = repo(path);
      return !existsSync(file) || blobId(readFileSync(file)) !== blob;
    })
    .map(({ path }) => path)
    .sort();
}

/** Every `path` in the table's first column (a row may name several files). */
function documentedFiles(): string[] {
  const doc = readFileSync(DOC, "utf8");
  const start = doc.indexOf(TABLE_HEADING);
  expect(start, `${TABLE_HEADING} is missing`).toBeGreaterThan(-1);
  const section = doc.slice(start + TABLE_HEADING.length);
  const end = section.search(/^## /m);
  const files = new Set<string>();
  for (const line of (end === -1 ? section : section.slice(0, end)).split(
    "\n",
  )) {
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const [, path] of firstCell.matchAll(/`([^`]+)`/g)) {
      if (path) files.add(path);
    }
  }
  return [...files].sort();
}

describe("docs/fork-customizations.md lists every changed upstream file", () => {
  if (process.env.FORK_UPSTREAM_MANIFEST_WRITE) {
    writeManifest(process.env.FORK_UPSTREAM_MANIFEST_WRITE);
  }

  it("the manifest is readable", () => {
    expect(readManifest().length).toBeGreaterThan(500);
  });

  it("the hook-in table names exactly the changed upstream files", () => {
    const changed = changedUpstreamFiles();
    const documented = documentedFiles();
    const missing = changed.filter((path) => !documented.includes(path));
    const extra = documented.filter((path) => !changed.includes(path));
    expect(
      { missing, extra },
      [
        "docs/fork-customizations.md, table under '## Upstream files with a hook-in':",
        "add a row for each 'missing' file (an upstream file this checkout changes),",
        "and drop each 'extra' one (not an upstream file, or back to upstream).",
      ].join(" "),
    ).toEqual({ missing: [], extra: [] });
  });
});
