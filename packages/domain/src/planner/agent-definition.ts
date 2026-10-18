import {
  PLANNER_AGENT_MCP_PATH,
  PLANNER_AGENT_MCP_SERVER,
  plannerAgentProposeTools,
} from "@flaremo/contracts";

// How the general agent is wired (fork-owned add-on, docs/fork-general-agent.md):
// the parts of its Managed Agents configuration that the setup script
// (scripts/fork/general-agent.ts) stores on the agent and that the Worker
// repeats when one session needs different tools (the Ask chat, which may not
// propose). Plain data, no API calls.

/** The skills the agent carries, by folder under skills/. */
export const PLANNER_AGENT_SKILLS = [
  "weekly-review",
  "period-review",
  "ask-my-diary",
  "goal-check",
] as const;

/** The MCP server the agent reaches, at this deployment's public origin. */
export function plannerAgentMcpServers(publicOrigin: string) {
  return [
    {
      type: "url" as const,
      name: PLANNER_AGENT_MCP_SERVER,
      url: `${publicOrigin.replace(/\/+$/, "")}${PLANNER_AGENT_MCP_PATH}`,
    },
  ];
}

/**
 * The agent's tools. The sandbox tools read and write its own files (the memo
 * it writes, its memory store, a tool result too long to inline); the web is
 * off. The diary server's tools run without asking: it is the app's own
 * server and its only writes are proposals the owner decides on. With
 * `propose: false` the three propose tools are off, as in the Ask chat.
 */
export function plannerAgentTools(options: { propose: boolean }) {
  return [
    {
      type: "agent_toolset_20260401" as const,
      default_config: {
        enabled: true,
        permission_policy: { type: "always_allow" as const },
      },
      configs: [
        { name: "web_search", enabled: false },
        { name: "web_fetch", enabled: false },
      ],
    },
    {
      type: "mcp_toolset" as const,
      mcp_server_name: PLANNER_AGENT_MCP_SERVER,
      default_config: {
        enabled: true,
        permission_policy: { type: "always_allow" as const },
      },
      configs: options.propose
        ? []
        : plannerAgentProposeTools.map((name) => ({ name, enabled: false })),
    },
  ];
}
