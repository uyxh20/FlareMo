// Sets up the general agent (fork-owned, docs/fork-general-agent.md) for one
// deployment: its skills from skills/, the Claude Managed Agent, its sandbox,
// its memory store and its vault, then prints the five Worker vars that turn
// it on. Dev and prod each get their own agent, skills, store and vault, so a
// change tried on dev never reaches prod's agent before prod's own run. Safe
// to run again: it finds what exists by name, uploads a skill only when its
// folder changed, updates the agent only when its configuration changed, and
// creates only what is missing.
//
//   pnpm exec tsx scripts/fork/general-agent.ts --owner <first name> --target dev
//   pnpm exec tsx scripts/fork/general-agent.ts --owner <first name> --target prod
//
// Needs ANTHROPIC_API_KEY (or Anthropic_API), or a network secret that adds the
// key (header x-api-key) for api.anthropic.com. In a Claude cloud session that
// host skips the proxy, so run it through the proxy for the secret to apply:
//   NODE_USE_ENV_PROXY=1 NO_PROXY=localhost,127.0.0.1 pnpm exec tsx …
// Prints ids only, never the key.
// The vault starts empty: the Worker puts the agent's own read-only key into
// it before its first session.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  PLANNER_AGENT_SKILLS,
  plannerAgentMcpServers,
  plannerAgentTools,
} from "../../packages/domain/src/planner/agent-definition";
import { plannerAgentSystem } from "../../packages/domain/src/planner/agent-prompts";
import { DEV } from "./dev-env-config.mjs";
import { PROD } from "./dev-env-guard.mjs";

const API = "https://api.anthropic.com/v1";
const AGENTS = "managed-agents-2026-04-01";
const MEMORY = "agent-memory-2026-07-22";
const MODEL = { id: "claude-opus-5-5", effort: { type: "high" } };
const ENVIRONMENT_NAME = "schizo-diary-agent";
const ORIGINS = { dev: DEV.publicUrl, prod: PROD.publicUrl } as const;
const SKILLS_DIR = new URL("../../skills/", import.meta.url).pathname;

const { values: args } = parseArgs({
  options: {
    owner: { type: "string" },
    target: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!args.owner) fail("--owner <first name> is required.");
const target = args.target;
if (target !== "dev" && target !== "prod") {
  fail("--target is required: dev or prod.");
}
// Without the variable, a network proxy may supply the key (a network
// secret for api.anthropic.com); the placeholder is replaced on the way out.
const key = (
  process.env.ANTHROPIC_API_KEY ??
  process.env.Anthropic_API ??
  "proxy-injected"
).trim();

type Named = { id: string; name: string };
const label = `Schizo Diary agent (${target})`;

async function api<T>(
  path: string,
  options: { body?: unknown; form?: FormData; beta?: string } = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method:
      options.body === undefined && options.form === undefined ? "GET" : "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      ...(options.beta ? { "anthropic-beta": options.beta } : {}),
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: options.form ?? JSON.stringify(options.body),
  });
  const json = (await response.json()) as T & { error?: { message: string } };
  if (response.status === 401) {
    fail(
      "Anthropic refused the key: set ANTHROPIC_API_KEY, or a network secret for api.anthropic.com.",
    );
  }
  if (!response.ok)
    fail(`${path}: ${response.status} ${json.error?.message ?? ""}`);
  return json;
}

const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

async function folderFiles(folder: string) {
  const root = join(SKILLS_DIR, folder);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return {
          name: `${folder}/${relative(root, path)}`,
          content: await readFile(path),
        };
      }),
  );
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

// --- The skills: one per folder and deployment, a new version when it changed.

const agents = await api<{
  data: Array<
    Named & { version: number; metadata?: Record<string, string> | null }
  >;
}>("/agents?limit=100", { beta: AGENTS });
let agent = agents.data.find((item) => item.name === label);
const metadata = { ...(agent?.metadata ?? {}) };

const skillList = await api<{
  data: Array<{ id: string; display_name: string }>;
}>("/skills?source=custom&limit=100");
const skills: Array<{ type: "custom"; skill_id: string; version: string }> = [];
for (const folder of PLANNER_AGENT_SKILLS) {
  const files = await folderFiles(folder);
  const digest = hash(
    files.map((file) => `${file.name}\n${file.content.toString()}`).join("\n"),
  );
  const display = `Schizo Diary ${folder} (${target})`;
  const existing = skillList.data.find((s) => s.display_name === display);
  const [storedDigest, storedVersion] = (
    metadata[`skill:${folder}`] ?? ""
  ).split("@");
  if (existing && storedDigest === digest && storedVersion) {
    skills.push({
      type: "custom",
      skill_id: existing.id,
      version: storedVersion,
    });
    continue;
  }
  const form = new FormData();
  if (!existing) form.append("display_name", display);
  for (const file of files) {
    form.append("files[]", new Blob([file.content]), file.name);
  }
  // A new skill answers with its first version's id; a new version, with its own.
  const { skillId, version } = existing
    ? {
        skillId: existing.id,
        version: (
          await api<{ id: string }>(`/skills/${existing.id}/versions`, {
            form,
          })
        ).id,
      }
    : await api<{ id: string; latest_version_id: string }>("/skills", {
        form,
      }).then((made) => ({
        skillId: made.id,
        version: made.latest_version_id,
      }));
  console.log(`Uploaded the ${folder} skill (${version}).`);
  metadata[`skill:${folder}`] = `${digest}@${version}`;
  skills.push({ type: "custom", skill_id: skillId, version });
}

// --- The sandbox: no web, no package installs; it reaches the diary's MCP
// server only, and only with the key in the vault.

const environments = await api<{ data: Named[] }>("/environments?limit=100", {
  beta: AGENTS,
});
const environment =
  environments.data.find((e) => e.name === ENVIRONMENT_NAME) ??
  (await api<Named>("/environments", {
    beta: AGENTS,
    body: {
      name: ENVIRONMENT_NAME,
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allow_package_managers: false,
          allow_mcp_servers: true,
        },
      },
    },
  }));

// --- The agent: created, or updated when its configuration changed.

const config = {
  model: MODEL,
  system: plannerAgentSystem(args.owner),
  mcp_servers: plannerAgentMcpServers(ORIGINS[target]),
  tools: plannerAgentTools({ propose: true }),
  skills,
};
metadata.config = hash(JSON.stringify(config));
if (!agent) {
  agent = await api("/agents", {
    beta: AGENTS,
    body: {
      name: label,
      description:
        "Reads the whole Schizo Diary through its read-only MCP server; runs the weekly and period reviews, answers Ask my diary and proposes goals, tasks and memories.",
      ...config,
      metadata,
    },
  });
  console.log(`Created the agent (version ${agent?.version}).`);
} else if (JSON.stringify(agent.metadata ?? {}) !== JSON.stringify(metadata)) {
  agent = await api(`/agents/${agent.id}`, {
    beta: AGENTS,
    body: { version: agent.version, ...config, metadata },
  });
  console.log(`Updated the agent (now version ${agent?.version}).`);
} else {
  console.log("The agent is up to date.");
}

// --- Its notes: the weekly memo agent's store, so its notes carry over.

const storeName = `review-notes-${target}`;
const stores = await api<{ data: Named[] }>("/memory_stores?limit=100", {
  beta: MEMORY,
});
const store =
  stores.data.find((s) => s.name === storeName) ??
  (await api<Named>("/memory_stores", {
    beta: MEMORY,
    body: {
      name: storeName,
      description:
        "Your own notes from earlier reviews and chats with this person: open threads, what they said they would do, patterns to re-check, mistakes to avoid. Read before a job; update only when a step says so. Notes only, never a copy of the diary or a memo.",
    },
  }));

// --- Its vault: the Worker keeps the agent's key here.

const vaults = await api<{
  data: Array<{ id: string; display_name: string }>;
}>("/vaults?limit=100", { beta: AGENTS });
const vault =
  vaults.data.find((v) => v.display_name === label) ??
  (await api<{ id: string }>("/vaults", {
    beta: AGENTS,
    body: { display_name: label },
  }));

console.log(`
Worker vars for ${target} (not secrets):
  FLAREMO_AGENT=${agent?.id}
  FLAREMO_AGENT_ENVIRONMENT=${environment.id}
  FLAREMO_AGENT_STORE=${store.id}
  FLAREMO_AGENT_VAULT=${vault.id}
Optional: FLAREMO_AGENT_RUN_USD (default 5), FLAREMO_AGENT_MONTH_USD (default 30).
The Worker also needs the secret ANTHROPIC_API_KEY.`);
