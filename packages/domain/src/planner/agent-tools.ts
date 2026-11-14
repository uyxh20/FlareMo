import {
  type PlannerAgentToolName,
  plannerAgentToolInputs,
} from "@flaremo/contracts";

// The general agent's MCP tools (fork-owned add-on, docs/fork-general-agent.md):
// what each one reads, as text the agent reads. The Worker's MCP endpoint
// (routes/planner-agent-mcp.ts) answers `tools/call` with these, and so does the
// eval runner's bridge. Every read is the owner's own rows only. The propose
// tools are the agent's only writes, and each lands where the owner decides on
// it: a goal or task waits on the review page, and
// an action (one task field, a new task, a new diary entry; migration 9015) as
// a card in the chat it was proposed in. The review proposals work only while a
// review is at a step that asks for them (the Ask chat has them turned off in
// its tool settings); the actions only while an Ask chat is answering.

import { plannerAgentProposeHandlers } from "./agent-tools-propose";
import { plannerAgentReadHandlers } from "./agent-tools-read";
/** A whole diary for the agent: it reads tool results, so nothing is cut. */
import {
  type Handlers,
  type PlannerAgentToolContext,
  PlannerAgentToolError,
} from "./agent-tools-shared";

export {
  PLANNER_AGENT_DIARY_CHARS,
  type PlannerAgentLinkReading,
  type PlannerAgentToolContext,
  PlannerAgentToolError,
  plannerAgentLinkKey,
  plannerAgentLinksIn,
  plannerAgentLinkText,
} from "./agent-tools-shared";

const handlers: Handlers = {
  ...plannerAgentReadHandlers,
  ...plannerAgentProposeHandlers,
};

/**
 * Runs one tool for the owner and returns its text. A bad input or a refused
 * proposal is a PlannerAgentToolError, whose message the agent can act on.
 */
export async function plannerAgentCallTool(
  context: PlannerAgentToolContext,
  name: string,
  args: unknown,
): Promise<string> {
  if (!Object.hasOwn(plannerAgentToolInputs, name)) {
    throw new PlannerAgentToolError(`There is no tool named ${name}.`);
  }
  const tool = name as PlannerAgentToolName;
  const parsed = plannerAgentToolInputs[tool].safeParse(args ?? {});
  if (!parsed.success) {
    throw new PlannerAgentToolError(
      parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.length ? issue.path.join(".") : "input"}: ${issue.message}`,
        )
        .join("; "),
    );
  }
  const handler = handlers[tool] as (
    context: PlannerAgentToolContext,
    input: unknown,
  ) => Promise<string>;
  return handler(context, parsed.data);
}
