import { PLANNER_AGENT_KEY_NAME } from "@flaremo/contracts";
import { ForbiddenError } from "@flaremo/domain";

// The general agent's key (fork-owned, docs/fork-general-agent.md). The Worker
// gives the agent an ordinary Better Auth personal access token with a reserved
// name and puts it in the agent's vault on Anthropic's side, never anywhere
// else. That key opens one door, the agent's own MCP server
// (routes/planner-agent-mcp.ts accepts nothing else): every other route
// refuses it here, through one call in context.ts. The server's tools read and
// propose; none edits or deletes, so the key can do no more.

/** Is this verified key the agent's? Better Auth returns the key's name. */
export function forkIsAgentKey(key: unknown): boolean {
  return (
    typeof key === "object" &&
    key !== null &&
    (key as { name?: unknown }).name === PLANNER_AGENT_KEY_NAME
  );
}

/** Called by getRequestContext on every verified PAT: the agent's key stops here. */
export function forkRefuseAgentKey(key: unknown): void {
  if (forkIsAgentKey(key)) {
    throw new ForbiddenError("This key only opens the agent's MCP server.");
  }
}
