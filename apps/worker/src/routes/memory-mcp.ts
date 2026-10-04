import {
  bootstrapInputSchema,
  checkpointInputSchema,
  compileInputSchema,
  FLAREMO_API_VERSION,
  forgetInputSchema,
  linkInputSchema,
  recallInputSchema,
  rememberInputSchema,
} from "@flaremo/contracts";
import {
  assertMonthlyQuota,
  bootstrapMemory,
  checkpointMemory,
  compileCoreMemory,
  createMemory,
  DomainError,
  estimateTokenCount,
  forgetMemory,
  incrementUsageCounter,
  linkMemory,
  type MemoryActor,
  recallMemories,
  rememberInputToWrite,
  ValidationError,
} from "@flaremo/domain";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  getRequestContext,
  type HonoBindings,
  type ReturnTypeOfRequestContext,
} from "../context";
import { createEmbeddingProvider, createVectorIndex } from "../embedding";
import { jsonError } from "../http";
import {
  formatZodError,
  negotiatedProtocolVersion,
  normalizeStructuredContent,
  optionalString,
  requestIdOf,
  streamableMcpRequestSchema,
  streamableToolCallSchema,
  streamableToolError,
} from "../mcp-protocol";

export const memoryMcpApi = new Hono<HonoBindings>();

type JsonObject = Record<string, unknown>;
type McpId = string | number | null;

// The agent-facing memory MCP exposes a deliberately small surface. The six
// tools encode the write/recall policy in their descriptions so behavior stays
// consistent across Claude Code, Codex, Pi, and any other client that connects
// to this endpoint — no external system prompt is required.
const memoryTools: Array<{
  name: string;
  description: string;
  inputSchema: JsonObject;
}> = [
  {
    name: "memory_bootstrap",
    description:
      "Restore long-term context at the start of a session. Returns the user's " +
      "global and project core memories, important active decisions and " +
      "constraints, and recent relevant lessons, capped by a character budget. " +
      "Call once when entering a new project or important session; do not call " +
      "on every turn.",
    inputSchema: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: {
          type: "string",
          description: "The calling agent, e.g. codex.",
        },
        project_key: {
          type: "string",
          description: "Project identifier, e.g. github:owner/repo.",
        },
        workspace_key: { type: "string" },
        cwd: {
          type: "string",
          description: "Current working directory, context only.",
        },
        task: {
          type: "string",
          description: "A short description of the task.",
        },
        max_items: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_recall",
    description:
      "Search long-term memory for relevant facts, decisions, preferences, or " +
      "lessons, using deterministic fact-key hits, full-text search, semantic " +
      "similarity, and one-hop relation expansion fused by rank. Results are " +
      "scoped to global plus the requested project/workspace and the calling " +
      "agent; cross-project recall is not allowed. Each result carries the paths " +
      "that matched it. Use when the task involves historical decisions, user " +
      "preferences, project constraints, or past failures.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Natural-language query." },
        agent: {
          type: "string",
          description: "The calling agent, e.g. codex.",
        },
        project_key: { type: "string" },
        workspace_key: { type: "string" },
        from_scope: {
          type: "string",
          description:
            "Read across projects by exact scope key. Omit for normal scoped recall.",
        },
        fact_key: {
          type: "string",
          description: "Exact fact key; a hit short-circuits to the top.",
        },
        as_of: {
          type: "string",
          description:
            "ISO instant; answers with the facts that were valid then (time travel).",
        },
        include_inferred: {
          type: "boolean",
          description:
            "Include unconfirmed conjectures. Off by default; only use when the user asks for proposals.",
        },
        include_superseded: { type: "boolean" },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["semantic", "episodic", "procedural"],
          },
        },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "preference",
              "fact",
              "decision",
              "constraint",
              "entity",
              "event",
              "outcome",
              "lesson",
              "procedure",
            ],
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_remember",
    description:
      "Save a single atomic long-term fact. One memory = one stable conclusion " +
      "(e.g. 'FlareMo uses D1'); long-form content belongs in a memo, not a " +
      "memory. Only record what has future value across sessions. Never store " +
      "secrets, tokens, passwords, cookies, or authorization headers. Agents " +
      "record as observed or inferred only — they can never lock or confirm a " +
      "memory, and they cannot overwrite a memory the user confirmed or locked.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string", maxLength: 4000 },
        type: {
          type: "string",
          enum: ["semantic", "episodic", "procedural"],
          default: "semantic",
        },
        kind: {
          type: "string",
          enum: [
            "preference",
            "fact",
            "decision",
            "constraint",
            "entity",
            "event",
            "outcome",
            "lesson",
            "procedure",
          ],
          default: "fact",
        },
        scope_type: {
          type: "string",
          enum: ["global", "workspace", "project", "agent"],
          default: "global",
        },
        scope_key: { type: "string" },
        tier: { type: "string", enum: ["core", "normal"], default: "normal" },
        importance: { type: "integer", minimum: 0, maximum: 100, default: 50 },
        confidence: { type: "integer", minimum: 0, maximum: 100, default: 50 },
        verification: {
          type: "string",
          enum: ["inferred", "observed"],
          default: "observed",
        },
        source_agent: { type: "string" },
        source_session: { type: "string" },
        source_ref: { type: "string" },
        fact_key: {
          type: "string",
          description:
            "Deterministic key for the one fact this memory states, e.g. 'db.primary_engine'. " +
            "Writing the same key again supersedes the previous version when both are agent " +
            "memories; if the existing version is user-owned (confirmed/locked), the write is " +
            "downgraded to a proposal for the user to decide.",
        },
        tags: {
          type: "array",
          items: { type: "string", maxLength: 64 },
          description:
            "Free-form topic labels for navigation only. They never trigger supersession.",
        },
        idempotency_key: {
          type: "string",
          description:
            "Opaque retry key. Reusing it returns the first result instead of creating a duplicate.",
        },
        valid_from: {
          type: "string",
          description:
            "ISO instant this fact becomes true. Defaults to now; a future value schedules it.",
        },
        observed_at: {
          type: "string",
          description:
            "ISO instant the agent observed this, if different from now.",
        },
        evidence: {
          type: "array",
          description:
            "Where this conclusion came from, so the user can audit it.",
          items: {
            type: "object",
            required: ["source_id"],
            properties: {
              source_type: {
                type: "string",
                enum: [
                  "memo",
                  "session",
                  "github",
                  "url",
                  "document",
                  "manual",
                  "other",
                ],
                default: "session",
              },
              source_id: { type: "string" },
              source_revision: { type: "string" },
              relation_type: {
                type: "string",
                enum: [
                  "derived_from",
                  "evidence_for",
                  "contradicts",
                  "references",
                ],
                default: "derived_from",
              },
              observed_at: { type: "string" },
              excerpt: { type: "string" },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_compile",
    description:
      "Build the memory projection for a context: the exact Markdown an agent " +
      "should carry into a session, already packed within a character budget. " +
      "Iron rules (pinned) are always included; unconfirmed conjectures never " +
      "are. Prefer this over calling memory_bootstrap and re-formatting it " +
      "yourself, so every agent receives the same bytes.",
    inputSchema: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: {
          type: "string",
          description: "The calling agent, e.g. codex.",
        },
        project_key: { type: "string" },
        workspace_key: { type: "string" },
        max_chars: { type: "integer", minimum: 500, maximum: 30000 },
        exclude_ids: {
          type: "array",
          items: { type: "string" },
          description: "Memories to leave out of this projection, by id.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_checkpoint",
    description:
      "Distill a finished piece of work into long-term lessons. Creates one " +
      "episodic summary plus the given atomic memories, linked together. Call " +
      "after completing an important feature, design, investigation, or decision. " +
      "Each item must be an atomic conclusion, not chat history or a todo.",
    inputSchema: {
      type: "object",
      required: ["agent", "summary", "items"],
      properties: {
        agent: { type: "string" },
        project_key: { type: "string" },
        scope_type: {
          type: "string",
          enum: ["global", "workspace", "project", "agent"],
          default: "project",
        },
        scope_key: { type: "string" },
        summary: { type: "string", maxLength: 4000 },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            required: ["content"],
            properties: {
              content: { type: "string", maxLength: 4000 },
              type: {
                type: "string",
                enum: ["semantic", "episodic", "procedural"],
                default: "semantic",
              },
              kind: {
                type: "string",
                enum: [
                  "preference",
                  "fact",
                  "decision",
                  "constraint",
                  "entity",
                  "event",
                  "outcome",
                  "lesson",
                  "procedure",
                ],
                default: "fact",
              },
              importance: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                default: 50,
              },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_link",
    description:
      "Link a memory to another memory (e.g. supersedes, contradicts, supports) " +
      "or to an external resource such as a memo. A supersedes link retires the " +
      "older memory from active recall without deleting its history.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        memory_id: { type: "string" },
        related_memory_id: { type: "string" },
        relation_type: {
          type: "string",
          enum: [
            "related_to",
            "supports",
            "contradicts",
            "supersedes",
            "depends_on",
            "part_of",
          ],
          default: "related_to",
        },
        resource_type: {
          type: "string",
          enum: ["memo", "session", "github", "url", "document", "other"],
        },
        resource_ref: { type: "string" },
        resource_relation_type: {
          type: "string",
          enum: ["derived_from", "evidence", "references", "promoted_to"],
          default: "references",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_forget",
    description:
      "Retire a memory that is now incorrect, superseded, or irrelevant. Agents " +
      "never hard-delete: this archives or supersedes the memory so the user can " +
      "still review it. Only the user can permanently delete a memory from the " +
      "FlareMo UI.",
    inputSchema: {
      type: "object",
      required: ["memory_id"],
      properties: {
        memory_id: { type: "string" },
        reason: {
          type: "string",
          enum: ["incorrect", "superseded", "expired", "irrelevant"],
          default: "superseded",
        },
      },
      additionalProperties: false,
    },
  },
];

memoryMcpApi.post("/", async (c) => {
  let context: ReturnTypeOfRequestContext;
  try {
    context = await getRequestContext(c);
  } catch (error) {
    return jsonError(c, error);
  }

  let rawRequest: unknown;
  try {
    rawRequest = await c.req.json();
  } catch {
    return streamableProtocolError(c, null, -32700, "Parse error");
  }

  const parsedRequest = streamableMcpRequestSchema.safeParse(rawRequest);
  if (!parsedRequest.success) {
    return streamableProtocolError(
      c,
      requestIdOf(rawRequest),
      -32600,
      formatZodError(parsedRequest.error),
    );
  }

  const request = parsedRequest.data;
  const id = request.id ?? null;

  if (request.method === "initialize") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiatedProtocolVersion(request.params),
        capabilities: { tools: {} },
        serverInfo: { name: "memory", version: FLAREMO_API_VERSION },
      },
    });
  }

  if (request.method === "notifications/initialized") {
    if (request.id === undefined) return new Response(null, { status: 202 });
    return c.json({ jsonrpc: "2.0", id, result: {} });
  }

  if (request.method === "tools/list") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: memoryTools.map((tool) => ({
          ...tool,
          outputSchema: { type: "object", additionalProperties: true },
        })),
      },
    });
  }

  if (request.method === "tools/call") {
    const parsedCall = streamableToolCallSchema.safeParse(request.params);
    if (!parsedCall.success) {
      return streamableToolError(c, id, formatZodError(parsedCall.error));
    }
    try {
      const value = await callMemoryTool(
        c,
        context,
        parsedCall.data.name,
        parsedCall.data.arguments ?? {},
      );
      return streamableToolSuccess(c, id, value);
    } catch (error) {
      return streamableToolError(c, id, readableError(error));
    }
  }

  return streamableProtocolError(c, id, -32601, "Method not found");
});

function resolveAgent(args: JsonObject): MemoryActor {
  const name = optionalString(args, "agent", "source_agent") ?? "agent";
  return { type: "agent", name };
}

async function callMemoryTool(
  c: Context<HonoBindings>,
  context: ReturnTypeOfRequestContext,
  name: string,
  args: JsonObject,
) {
  const { db, user } = context;
  switch (name) {
    case "memory_bootstrap": {
      const input = bootstrapInputSchema.parse(args);
      return bootstrapMemory(db, user, {
        agent: input.agent,
        projectKey: input.project_key,
        workspaceKey: input.workspace_key,
        maxItems: input.max_items,
      });
    }
    case "memory_recall": {
      const input = recallInputSchema.parse(args);
      const provider = createEmbeddingProvider(c.env);
      const index = createVectorIndex(c.env, "memory");
      if (provider && index) {
        await assertMonthlyQuota(
          context.db,
          context.limits.semanticSearchQueriesPerMonth,
          "search_queries",
          "Monthly semantic search quota exceeded",
          { userLimits: context.userLimits, userId: context.user.id },
        );
        c.executionCtx.waitUntil(
          Promise.all([
            incrementUsageCounter(
              context.db,
              context.user,
              "queried_dims",
              provider.dimensions,
            ).catch(() => undefined),
            incrementUsageCounter(
              context.db,
              context.user,
              "search_queries",
              1,
            ).catch(() => undefined),
            incrementUsageCounter(
              context.db,
              context.user,
              "embedding_tokens",
              estimateTokenCount([input.query]),
            ).catch(() => undefined),
          ]),
        );
      }
      return recallMemories(
        db,
        user,
        {
          query: input.query,
          agent: input.agent,
          projectKey: input.project_key,
          workspaceKey: input.workspace_key,
          fromScope: input.from_scope,
          factKey: input.fact_key,
          asOf: input.as_of,
          types: input.types,
          kinds: input.kinds,
          limit: input.limit,
          includeInferred: input.include_inferred,
          includeSuperseded: input.include_superseded,
        },
        // Memory vectors are indexed under per-user namespaces; recall must
        // query the caller's own namespace or it sees nothing.
        provider && index ? { provider, index, namespace: user.id } : undefined,
      );
    }
    case "memory_remember": {
      const input = rememberInputSchema.parse(args);
      const result = await createMemory(
        db,
        user,
        resolveAgent(args),
        rememberInputToWrite(input),
        { userLimits: context.userLimits, userId: user.id },
      );
      return result;
    }
    case "memory_compile": {
      const input = compileInputSchema.parse(args);
      // An agent compile is an actual injection: it is archived so the lens
      // can show "上次实际注入" from the record (§VI.7).
      return compileCoreMemory(db, user, input, {
        persist: true,
        agent: input.agent,
      });
    }
    case "memory_checkpoint": {
      const input = checkpointInputSchema.parse(args);
      return checkpointMemory(db, user, resolveAgent(args), input, {
        userLimits: context.userLimits,
        userId: user.id,
      });
    }
    case "memory_link": {
      const input = linkInputSchema.parse(args);
      return linkMemory(db, user, resolveAgent(args), {
        memoryId: normalizeMemoryId(input.memory_id),
        relatedMemoryId: input.related_memory_id
          ? normalizeMemoryId(input.related_memory_id)
          : undefined,
        relationType: input.relation_type,
        resourceType: input.resource_type,
        resourceRef: input.resource_ref,
        resourceRelationType: input.resource_relation_type,
      });
    }
    case "memory_forget": {
      const input = forgetInputSchema.parse(args);
      return forgetMemory(
        db,
        user,
        resolveAgent(args),
        normalizeMemoryId(input.memory_id),
        {
          reason: input.reason,
        },
      );
    }
    default:
      throw new ValidationError(`Unknown tool: ${name}`);
  }
}

function normalizeMemoryId(value: string) {
  return value.startsWith("memories/") ? value : `memories/${value}`;
}

// --- protocol helpers (mirror mcp.ts) --------------------------------------

function streamableProtocolError(
  c: Context<HonoBindings>,
  id: McpId,
  code: number,
  message: string,
) {
  return c.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function streamableToolSuccess(
  c: Context<HonoBindings>,
  id: McpId,
  value: unknown,
) {
  const structuredContent = normalizeStructuredContent(value);
  return c.json({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  });
}

function readableError(error: unknown) {
  if (error instanceof z.ZodError) return formatZodError(error);
  // Only domain-level errors carry a caller-facing message. Anything else
  // (D1 failures, TypeErrors, …) is logged server-side and stays generic.
  if (error instanceof DomainError) return error.message;
  console.error(
    JSON.stringify({
      level: "error",
      message: "Unhandled memory MCP tool error",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return "Tool call failed.";
}
