import type { Zippable } from "fflate";
import { checkPluginFiles } from "./check";
import { PLUGIN_PACKAGE_LIMITS, type PluginManifest } from "./spec";

/**
 * The zip codec is loaded on first use.
 *
 * `fflate`'s browser bundle is ~89 KiB and this module is re-exported through
 * the plugins barrel, which the worker imports on its request path — so the
 * codec sat in every isolate's startup parse for a feature that only runs when
 * an operator installs a plugin (or when the build scripts package one). Making
 * the two entry points async is the whole cost: neither is on a hot path, and
 * `import()` resolves from the module registry after the first call.
 */
const loadZip = () => import("fflate");

/**
 * Plugin package = the zip distributed by the store and produced by
 * `pnpm plugins:build`. Layout: a single top-level folder named after the
 * plugin id, holding `plugin.json` plus the card files it references.
 *
 * Both directions live here: `zipPluginFiles` (build scripts) and the readers
 * (worker install + tests + CLI). Extraction only enforces physical safety
 * (path rules, size limits, single root folder); every semantic rule —
 * manifest, documents, sandbox self-containment — lives in `check.ts`, so the
 * CLI, the repo build and the instance all judge packages by the same rules.
 */

export { PLUGIN_PACKAGE_LIMITS } from "./spec";

export type PluginPackage = {
  manifest: PluginManifest;
  /** Paths are relative to the plugin folder (the `<id>/` prefix is stripped). */
  files: Record<string, Uint8Array>;
};

export type ExtractedPackage = {
  /** Package-relative files (prefix stripped), even when `problems` is set. */
  files: Record<string, Uint8Array>;
  rootFolder: string | null;
  problems: string[];
};

const textDecoder = new TextDecoder();

/** Read a package-relative file as UTF-8 text (authors and CLIs). */
export function readFileText(
  files: Record<string, Uint8Array>,
  path: string,
): string | null {
  const bytes = files[path];
  return bytes ? textDecoder.decode(bytes) : null;
}

function assertSafePath(name: string): string | null {
  if (!name || name.length > 200) {
    return `package contains an unsafe path: "${name}"`;
  }
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[a-zA-Z]:/.test(name)
  ) {
    return `package contains an unsafe path: "${name}"`;
  }
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return `package contains an unsafe path: "${name}"`;
    }
  }
  return null;
}

/**
 * Unpack a plugin zip and apply the physical rules. Never throws: returns the
 * extracted (prefix-stripped) files plus any structural problems, so the CLI
 * can report everything in one pass.
 */
export async function extractPluginPackage(
  bytes: Uint8Array,
): Promise<ExtractedPackage> {
  const problems: string[] = [];
  if (bytes.byteLength === 0) {
    return { files: {}, rootFolder: null, problems: ["package is empty"] };
  }
  if (bytes.byteLength > PLUGIN_PACKAGE_LIMITS.maxZipBytes) {
    return {
      files: {},
      rootFolder: null,
      problems: [
        `package exceeds the ${Math.round(PLUGIN_PACKAGE_LIMITS.maxZipBytes / 1024 / 1024)}MB limit`,
      ],
    };
  }
  let raw: Record<string, Uint8Array>;
  let totalBytes = 0;
  let fileCount = 0;
  try {
    const { unzipSync } = await loadZip();
    raw = unzipSync(bytes, {
      filter: (file) => {
        fileCount += 1;
        if (fileCount > PLUGIN_PACKAGE_LIMITS.maxFiles) {
          throw new Error(
            `package has more than ${PLUGIN_PACKAGE_LIMITS.maxFiles} files`,
          );
        }
        if (file.originalSize > PLUGIN_PACKAGE_LIMITS.maxFileBytes) {
          throw new Error(`"${file.name}" exceeds the per-file size limit`);
        }
        totalBytes += file.originalSize;
        if (totalBytes > PLUGIN_PACKAGE_LIMITS.maxTotalBytes) {
          throw new Error("package exceeds the total uncompressed size limit");
        }
        return true;
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      files: {},
      rootFolder: null,
      problems: [`package is not a readable zip: ${message}`],
    };
  }

  const names = Object.keys(raw);
  if (names.length === 0) {
    return {
      files: {},
      rootFolder: null,
      problems: ["package contains no files"],
    };
  }
  for (const name of names) {
    const problem = assertSafePath(name);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0) {
    return { files: {}, rootFolder: null, problems };
  }

  const rootName = names[0]?.split("/")[0] ?? "";
  if (!rootName) {
    return {
      files: {},
      rootFolder: null,
      problems: ["package must contain a top-level plugin folder"],
    };
  }
  const prefix = `${rootName}/`;
  const files: Record<string, Uint8Array> = {};
  for (const name of names) {
    if (!name.startsWith(prefix)) {
      problems.push(
        `package must keep every file inside "${rootName}/" (found "${name}")`,
      );
      continue;
    }
    files[name.slice(prefix.length)] = raw[name] as Uint8Array;
  }
  return { files, rootFolder: rootName, problems };
}

/**
 * Unpack + fully validate a plugin zip. Throws with the collected reasons —
 * used by the instance on upload/install so a package that fails the author's
 * `pnpm plugin:check` can never be installed.
 */
export async function readPluginPackage(
  bytes: Uint8Array,
): Promise<PluginPackage> {
  const extracted = await extractPluginPackage(bytes);
  if (extracted.problems.length > 0) {
    throw new Error(extracted.problems.join("; "));
  }
  const result = checkPluginFiles({
    files: extracted.files,
    rootFolder: extracted.rootFolder ?? undefined,
  });
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (!result.manifest || errors.length > 0) {
    const details = errors
      .map(
        (issue) => `${issue.where ? `${issue.where} · ` : ""}${issue.message}`,
      )
      .join("; ");
    throw new Error(
      `package failed validation: ${details || "invalid manifest"}`,
    );
  }
  return { manifest: result.manifest, files: extracted.files };
}

/**
 * Zip a plugin folder's files (keys must already carry the `<id>/` prefix).
 * Every entry gets a fixed mtime so rebuilding identical content yields a
 * byte-identical archive — the registry's sha256 must not drift per build.
 */
/** ZIP's minimum representable date; anything earlier gets clamped anyway. */
const ZIP_EPOCH = new Date("1980-01-01T00:00:00Z");

export async function zipPluginFiles(
  files: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  const entries: Zippable = {};
  for (const [name, data] of Object.entries(files)) {
    entries[name] = [data, { mtime: ZIP_EPOCH }];
  }
  const { zipSync } = await loadZip();
  return zipSync(entries, { level: 6 });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
