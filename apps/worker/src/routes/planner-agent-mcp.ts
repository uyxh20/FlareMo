import { FLAREMO_API_VERSION, plannerAgentToolList } from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  DomainError,
  ForbiddenError,
  getFlaremoUserByAuthUserId,
  isActiveTeamMember,
  UnauthorizedError,
} from "@flaremo/domain";
import {
  PlannerAgentToolError,
  plannerAgentCallTool,
} from "@flaremo/domain/src/planner";
import { type Context, Hono } from "hono";
import { MEMOS_PAT_CONFIG_ID, MEMOS_PAT_PREFIX } from "../auth-env";
import {
  assertRequestCredentialBoundary,
  getFlareMoAuth,
  getFlareMoDb,
  type HonoBindings,
} from "../context";
import { forkIsAgentKey } from "../fork/agent-key";
import { jsonError } from "../http";
import {
  formatZodError,
  isJsonObject,
  type McpId,
  negotiatedProtocolVersion,
  requestIdOf,
  streamableMcpRequestSchema,
  streamableToolCallSchema,
  streamableToolError,
} from "../mcp-protocol";

// The general agent's MCP server (fork-owned add-on,
// docs/fork-general-agent.md): POST /api/app/planner/agent/mcp, stateless
// Streamable HTTP like the app's own /mcp. The agent reaches it from
// Anthropic's side with the key the Worker keeps in its vault
// (planner-agent.ts), and this route takes that key and nothing else: no
// cookie, no other personal access token. Every other route refuses that key
// (fork/agent-key.ts), so it opens this server only.
//
// The tools are the domain's (packages/domain/src/planner/agent-tools.ts):
// reads of the owner's whole record, and three propose tools whose writes wait
// for the owner. A tool's text is the result; a refused call is a tool error
// the agent can act on. Nothing is logged but an unexpected error's message.

export const plannerAgentMcpApi = new Hono<HonoBindings>();

/** The owner the agent's key belongs to, or a 401/403. */
async function agentOwner(
  c: Context<HonoBindings>,
): Promise<{ db: FlareMoDb; user: UserRow }> {
  // A browser's Origin, if one is sent, must be trusted, as on every route.
  assertRequestCredentialBoundary(c);
  const header = c.req.header("authorization") ?? "";
  const [scheme, token, extra] = header.trim().split(/\s+/);
  if (
    scheme?.toLowerCase() !== "bearer" ||
    !token?.startsWith(MEMOS_PAT_PREFIX) ||
    extra
  ) {
    throw new UnauthorizedError();
  }
  const auth = await getFlareMoAuth(c.env);
  const verification = await auth.api.verifyApiKey({
    body: { configId: MEMOS_PAT_CONFIG_ID, key: token },
  });
  if (!verification.valid || !verification.key) {
    throw new UnauthorizedError();
  }
  if (!forkIsAgentKey(verification.key)) {
    throw new ForbiddenError("This server takes the agent's key only.");
  }
  const db = getFlareMoDb(c.env);
  const user = await getFlaremoUserByAuthUserId(
    db,
    verification.key.referenceId,
  );
  if (!user || !isActiveTeamMember(user)) throw new UnauthorizedError();
  return { db, user };
}

function protocolError(
  c: Context<HonoBindings>,
  id: McpId,
  code: number,
  message: string,
) {
  return c.json({ jsonrpc: "2.0", id, error: { code, message } });
}

/** The message a refused call returns to the agent; the rest stay generic. */
function toolErrorMessage(error: unknown): string {
  if (error instanceof PlannerAgentToolError) return error.message;
  if (error instanceof DomainError) return error.message;
  console.error(
    JSON.stringify({
      level: "error",
      message: "Agent tool failed",
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }),
  );
  return "The tool failed. Try again, or go on without it.";
}

plannerAgentMcpApi.post("/agent/mcp", async (c) => {
  let owner: { db: FlareMoDb; user: UserRow };
  try {
    owner = await agentOwner(c);
  } catch (error) {
    return jsonError(c, error);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return protocolError(c, null, -32700, "Parse error");
  }
  const parsed = streamableMcpRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const method = isJsonObject(raw) ? raw.method : undefined;
    return method === "tools/call"
      ? streamableToolError(c, requestIdOf(raw), formatZodError(parsed.error))
      : protocolError(
          c,
          requestIdOf(raw),
          -32600,
          formatZodError(parsed.error),
        );
  }
  const request = parsed.data;
  const id = request.id ?? null;

  if (request.method === "initialize") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiatedProtocolVersion(request.params),
        capabilities: { tools: {} },
        serverInfo: { name: "schizo-diary", version: FLAREMO_API_VERSION },
      },
    });
  }

  if (request.method === "notifications/initialized") {
    if (request.id === undefined) return new Response(null, { status: 202 });
    return c.json({ jsonrpc: "2.0", id, result: {} });
  }

  if (request.method === "ping") {
    return c.json({ jsonrpc: "2.0", id, result: {} });
  }

  if (request.method === "tools/list") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: { tools: plannerAgentToolList() },
    });
  }

  if (request.method === "tools/call") {
    const call = streamableToolCallSchema.safeParse(request.params);
    if (!call.success) {
      return streamableToolError(c, id, formatZodError(call.error));
    }
    try {
      const text = await plannerAgentCallTool(
        { db: owner.db, user: owner.user },
        call.data.name,
        call.data.arguments ?? {},
      );
      return c.json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }] },
      });
    } catch (error) {
      return streamableToolError(c, id, toolErrorMessage(error));
    }
  }

  return protocolError(c, id, -32601, "Method not found");
});
