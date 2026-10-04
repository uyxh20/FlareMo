// Native-memory importers: read ZCode/Codex memory stores, map every entry to
// a memory_remember call (👀 observed, never ✅/📌), redact secrets locally
// before anything leaves the machine.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexHome, piHome, zcodeHome } from "./paths.mjs";
import { resolveProject, sha256 } from "./project.mjs";
import { request as defaultRequest } from "./transport.mjs";

// --- redaction --------------------------------------------------------------

const SECRET_PATTERNS = [
  /memos_pat_\S+/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_\S+/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-\S+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(password|passwd|secret|token)\s*[:=]\s*\S+/gi,
];

export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED_SECRET]");
  return out;
}

// --- zcode -------------------------------------------------------------------

function candidateDirs(home) {
  const dirs = [home, join(home, "code")];
  for (const parent of [join(home, "code")]) {
    try {
      for (const a of readdirSync(parent, { withFileTypes: true })) {
        if (!a.isDirectory()) continue;
        const p1 = join(parent, a.name);
        dirs.push(p1);
        try {
          for (const b of readdirSync(p1, { withFileTypes: true })) {
            if (b.isDirectory()) dirs.push(join(p1, b.name));
          }
        } catch {}
      }
    } catch {}
  }
  try {
    for (const w of readdirSync(join(home, "WeChatProjects"), {
      withFileTypes: true,
    })) {
      if (w.isDirectory()) dirs.push(join(home, "WeChatProjects", w.name));
    }
  } catch {}
  return dirs;
}

/** Map a `<name>-<hash16>` memory dir back to the workspace path it hashes. */
export function zcodeProjectCandidates(env = process.env) {
  const home = env.HOME || homedir();
  const byHash = new Map();
  for (const dir of candidateDirs(home)) {
    byHash.set(sha256(dir).slice(0, 16), dir);
  }
  return byHash;
}

/** Minimal YAML-ish frontmatter: name, description, metadata.{type,originSessionId}. */
export function parseZcodeFrontmatter(text) {
  const out = {
    name: "",
    description: "",
    type: "",
    originSessionId: "",
    body: text,
  };
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  out.body = text.slice(end + 4).replace(/^\r?\n/, "");
  const lines = text.slice(3, end).split("\n");
  let inMeta = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^\s/.test(line)) {
      if (inMeta) {
        const m = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
        if (m) {
          if (m[1] === "type") out.type = m[2].trim();
          if (m[1] === "originSessionId") out.originSessionId = m[2].trim();
        }
      }
      continue;
    }
    inMeta = /^metadata:\s*$/.test(line);
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "name") out.name = m[2].trim();
    if (m[1] === "description") out.description = m[2].trim();
  }
  return out;
}

function firstParagraph(body) {
  const para = (body || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  return (para || "").slice(0, 500);
}

export function collectZcodeMemories(env = process.env) {
  const root = join(zcodeHome(env), "cli", "memories", "projects");
  const byHash = zcodeProjectCandidates(env);
  const items = [];
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const m = d.name.match(/^(.*)-([0-9a-f]{16})$/);
    const name = m ? m[1] : d.name;
    const hash16 = m ? m[2] : "";
    const workspace = hash16 ? byHash.get(hash16) : undefined;
    const memDir = join(root, d.name, "memory");
    let files = [];
    try {
      files = readdirSync(memDir).filter(
        (f) => f.endsWith(".md") && f !== "MEMORY.md",
      );
    } catch {
      continue;
    }
    for (const file of files) {
      const abs = join(memDir, file);
      const relpath = `${d.name}/memory/${file}`;
      let text = "";
      let mtime = null;
      try {
        text = readFileSync(abs, "utf-8");
        mtime = statSync(abs).mtime.toISOString();
      } catch {
        continue;
      }
      const fm = parseZcodeFrontmatter(text);
      const content = fm.description || firstParagraph(fm.body);
      if (!content) continue;
      const projectKey = workspace ? resolveProject(workspace, env) : null;
      const tags = ["imported", "zcode", fm.type].filter(Boolean);
      if (!projectKey) tags.push(`zcode-project:${name}`);
      items.push({
        args: {
          content: redact(content),
          idempotency_key: `import:zcode:${sha256(relpath).slice(0, 40)}`,
          type: "semantic",
          kind: "fact",
          scope_type: projectKey ? "project" : "global",
          scope_key: projectKey ?? undefined,
          tags,
          verification: "observed",
          source_agent: "zcode-import",
          source_session: fm.originSessionId || undefined,
          observed_at: mtime ?? undefined,
          evidence: [
            {
              source_type: "document",
              source_id: `zcode:${relpath}`,
              excerpt: redact(fm.body).slice(0, 2000),
            },
          ],
        },
        project: projectKey ?? "global",
        label: `${name}/${file}`,
      });
    }
  }
  return items;
}

// --- codex -------------------------------------------------------------------

function splitSections(text, level) {
  // level 1: "# " headings; level 2: "## " headings.
  const re = level === 1 ? /^# (.+)$/gm : /^## (.+)$/gm;
  const sections = [];
  let match;
  let prev = null;
  while (true) {
    match = re.exec(text);
    if (!match) break;
    if (prev) prev.body = text.slice(prev.end, match.index);
    prev = { title: match[1].trim(), end: re.lastIndex };
    sections.push(prev);
  }
  if (prev) prev.body = text.slice(prev.end);
  return sections;
}

function bullets(body) {
  return (body || "")
    .split("\n")
    .map((l) => l.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim())
    .filter(Boolean)
    .map((b) => b.slice(0, 1000));
}

function paragraph(body) {
  return (body || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(
      (p) =>
        p && !p.startsWith("#") && !p.startsWith("-") && !p.startsWith("*"),
    )
    .join("\n\n")
    .trim();
}

function sectionSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function codexItem({ scopeKey, section, text }) {
  const content = redact(text);
  return {
    args: {
      content,
      idempotency_key: `import:codex:${sha256(`${scopeKey ?? "global"}\n${section}\n${text}`).slice(0, 40)}`,
      type: "semantic",
      kind: "fact",
      scope_type: scopeKey ? "project" : "global",
      scope_key: scopeKey ?? undefined,
      tags: ["imported", "codex", sectionSlug(section)],
      verification: "observed",
      source_agent: "codex-import",
    },
    project: scopeKey ?? "global",
    label: `${section}: ${content.slice(0, 60)}`,
  };
}

export function collectCodexMemories(env = process.env) {
  const root = codexHome(env);
  const items = [];

  // memory_summary.md — global layer.
  const summaryPath = join(root, "memories", "memory_summary.md");
  if (existsSync(summaryPath)) {
    const text = readFileSync(summaryPath, "utf-8");
    for (const sec of splitSections(text, 2)) {
      if (sec.title === "User Profile") {
        const p = paragraph(sec.body);
        if (p)
          items.push(
            codexItem({ scopeKey: null, section: sec.title, text: p }),
          );
      } else if (
        sec.title === "User preferences" ||
        sec.title === "General Tips"
      ) {
        for (const b of bullets(sec.body)) {
          items.push(
            codexItem({ scopeKey: null, section: sec.title, text: b }),
          );
        }
      }
    }
  }

  // MEMORY.md — per-project task groups.
  const memoryPath = join(root, "memories", "MEMORY.md");
  if (existsSync(memoryPath)) {
    const text = readFileSync(memoryPath, "utf-8");
    const wanted = new Set([
      "User preferences",
      "Reusable knowledge",
      "Failures and how to do differently",
    ]);
    for (const group of splitSections(text, 1)) {
      if (!group.title.startsWith("Task Group:")) continue;
      // The path itself contains slashes; the separator is the first " / ".
      const rest = group.title.slice("Task Group:".length).trim();
      const sep = rest.indexOf(" / ");
      const cwd = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
      if (!cwd) continue;
      const scopeKey = resolveProject(cwd, env);
      for (const sec of splitSections(group.body ?? "", 2)) {
        if (!wanted.has(sec.title)) continue;
        for (const b of bullets(sec.body)) {
          items.push(codexItem({ scopeKey, section: sec.title, text: b }));
        }
      }
    }
  }

  return items;
}

// --- pi (pi-hermes-memory) ----------------------------------------------------

// pi-hermes entries are `§`-separated blocks, optionally carrying a trailing
// `<!-- created=YYYY-MM-DD, last=YYYY-MM-DD, project64=<base64> -->` comment.
function piEntries(text) {
  return text
    .split(/^§\s*$/m)
    .map((chunk) => {
      const meta = chunk.match(/<!--([\s\S]*?)-->/);
      const created = meta?.[1].match(/created=([0-9-]+)/)?.[1];
      const body = chunk.replace(/<!--[\s\S]*?-->/g, "").trim();
      return { body, created };
    })
    .filter((e) => e.body.length > 0);
}

function piItem({ scopeKey, relpath, index, body, created, extraTags = [] }) {
  const content = redact(body).slice(0, 4000);
  return {
    args: {
      content,
      idempotency_key: `import:pi:${sha256(`${relpath}#${index}\n${body}`).slice(0, 40)}`,
      type: "semantic",
      kind: "fact",
      scope_type: scopeKey ? "project" : "global",
      scope_key: scopeKey ?? undefined,
      tags: ["imported", "pi", ...extraTags],
      verification: "observed",
      source_agent: "pi-import",
      observed_at: created ?? undefined,
      evidence: [
        {
          source_type: "document",
          source_id: `pi:${relpath}#${index}`,
          excerpt: content.slice(0, 2000),
        },
      ],
    },
    project: scopeKey ?? "global",
    label: `${relpath}#${index}`,
  };
}

export function collectPiMemories(env = process.env) {
  const home = piHome(env);
  const items = [];

  // Global stores — only the live files; dotfile *.retired / *.recovery backups
  // and the mnemon ARCHIVE stay on disk, out of the ledger.
  const globalDir = join(home, "pi-hermes-memory");
  for (const file of ["MEMORY.md", "USER.md", "failures.md"]) {
    const abs = join(globalDir, file);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf-8");
    piEntries(text).forEach((e, i) => {
      items.push(
        piItem({
          scopeKey: null,
          relpath: `pi-hermes-memory/${file}`,
          index: i,
          body: e.body,
          created: e.created,
          extraTags: [
            file === "USER.md"
              ? "user"
              : file === "failures.md"
                ? "failure"
                : "memory",
          ],
        }),
      );
    });
  }

  // Per-project stores: dir name is the workspace basename. Map back to
  // ~/code/<name> when that directory exists; otherwise keep the entry global
  // with a pi-project tag so the origin is still visible.
  const projectsDir = join(home, "projects-memory");
  let dirs = [];
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true });
  } catch {}
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const abs = join(projectsDir, d.name, "MEMORY.md");
    if (!existsSync(abs)) continue;
    const candidate = join(env.HOME || homedir(), "code", d.name);
    const scopeKey = existsSync(candidate)
      ? resolveProject(candidate, env)
      : null;
    const text = readFileSync(abs, "utf-8");
    piEntries(text).forEach((e, i) => {
      items.push(
        piItem({
          scopeKey,
          relpath: `projects-memory/${d.name}/MEMORY.md`,
          index: i,
          body: e.body,
          created: e.created,
          extraTags: scopeKey ? [] : [`pi-project:${d.name}`],
        }),
      );
    });
  }

  return items;
}

// --- runner ------------------------------------------------------------------

export function collectImports(harness, env = process.env) {
  if (harness === "zcode") return collectZcodeMemories(env);
  if (harness === "codex") return collectCodexMemories(env);
  if (harness === "pi") return collectPiMemories(env);
  throw new Error(`unsupported import source: ${harness}`);
}

export async function runImport(
  harness,
  {
    apply = false,
    env = process.env,
    home,
    requestImpl = defaultRequest,
    timeoutMs = 8000,
  } = {},
) {
  const items = collectImports(harness, env);
  const result = {
    total: items.length,
    perProject: {},
    samples: [],
    sent: 0,
    skipped: [],
    unreachable: false,
  };
  for (const item of items) {
    result.perProject[item.project] =
      (result.perProject[item.project] ?? 0) + 1;
    if (result.samples.length < 5) {
      result.samples.push({
        project: item.project,
        label: item.label,
        content: item.args.content.slice(0, 120),
      });
    }
  }
  if (!apply) return result;

  for (const item of items) {
    let res;
    for (let attempt = 0; ; attempt += 1) {
      res = await requestImpl("memory_remember", item.args, {
        timeoutMs,
        env,
        home,
      });
      if (!res.unreachable || attempt >= 3) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    if (res.ok) {
      result.sent += 1;
    } else if (res.unreachable) {
      result.unreachable = true;
      result.skipped.push({ label: item.label, reason: "unreachable" });
      break; // no point hammering a dead endpoint
    } else {
      result.skipped.push({
        label: item.label,
        reason: res.error ?? `HTTP ${res.status}`,
      });
    }
  }
  return result;
}
