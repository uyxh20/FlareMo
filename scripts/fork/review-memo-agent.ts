// Sets up the weekly memo agent (fork-owned, docs/fork-review-memo-agent.md):
// the Claude Managed Agent, its sandbox (no network) and one memory store per
// deployment, then prints the three Worker vars that turn it on. Safe to run
// again: it finds what exists by name, updates the agent's prompt when the
// code's prompt changed, and creates only what is missing.
//
//   pnpm exec tsx scripts/fork/review-memo-agent.ts --owner <first name> --store dev
//   pnpm exec tsx scripts/fork/review-memo-agent.ts --owner <first name> --store prod
//
// Needs ANTHROPIC_API_KEY (or Anthropic_API). Prints ids only, never the key.

import { parseArgs } from "node:util";
import { plannerMemoAgentSystem } from "../../packages/domain/src/planner/memo-agent";

const API = "https://api.anthropic.com/v1";
const AGENT_NAME = "Schizo Diary weekly memo";
const ENVIRONMENT_NAME = "schizo-diary-memo";
const MODEL = "claude-opus-5-5";

const { values: args } = parseArgs({
  options: {
    owner: { type: "string" },
    store: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!args.owner) fail("--owner <first name> is required.");
if (!args.store || !/^[a-z0-9-]+$/.test(args.store)) {
  fail("--store <deployment> is required: dev or prod.");
}
const key = (
  process.env.ANTHROPIC_API_KEY ??
  process.env.Anthropic_API ??
  fail("ANTHROPIC_API_KEY is not set.")
).trim();

async function api<T>(
  path: string,
  options: { body?: unknown; beta: string },
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": options.beta,
      "content-type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok)
    fail(`${path}: ${response.status} ${json.error?.message ?? ""}`);
  return json;
}

const AGENTS = "managed-agents-2026-04-01";
const MEMORY = "agent-memory-2026-07-22";
type Named = { id: string; name: string };

const system = plannerMemoAgentSystem(args.owner);
const tools = [
  {
    type: "agent_toolset_20260401",
    // Nobody watches a memo being written, so nothing may wait for approval.
    default_config: {
      enabled: true,
      permission_policy: { type: "always_allow" },
    },
    configs: [
      { name: "web_fetch", enabled: false },
      { name: "web_search", enabled: false },
    ],
  },
];

// The sandbox: no network, no package installs. The diary goes nowhere.
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
          allow_mcp_servers: false,
        },
      },
    },
  }));

const agents = await api<{
  data: Array<Named & { system: string; version: number }>;
}>("/agents?limit=100", { beta: AGENTS });
let agent = agents.data.find((a) => a.name === AGENT_NAME);
if (!agent) {
  agent = await api("/agents", {
    beta: AGENTS,
    body: {
      name: AGENT_NAME,
      description:
        "Writes the Sunday summary memo of the Schizo Diary weekly review.",
      model: { id: MODEL, effort: { type: "high" } },
      system,
      tools,
    },
  });
  console.log(`Created the agent (version ${agent!.version}).`);
} else if (agent.system !== system) {
  agent = await api(`/agents/${agent.id}`, {
    beta: AGENTS,
    body: { version: agent.version, system },
  });
  console.log(`Updated the agent's prompt (now version ${agent!.version}).`);
}

// One store per deployment: dev's notes come from the dev copy of the diary.
const storeName = `review-notes-${args.store}`;
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
        "Your own notes from earlier weekly reviews of this person: open threads, what they said they would do, patterns to re-check, mistakes to avoid. Read before writing; update after. Notes only, never a copy of the diary or the memo.",
    },
  }));

console.log(`
Worker vars for ${args.store} (not secrets):
  FLAREMO_REVIEW_MEMO_AGENT=${agent!.id}
  FLAREMO_REVIEW_MEMO_ENVIRONMENT=${environment.id}
  FLAREMO_REVIEW_MEMO_STORE=${store.id}
The Worker also needs the secret ANTHROPIC_API_KEY.`);
