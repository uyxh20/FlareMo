import type { PlannerChatMessage } from "@flaremo/domain/src/planner";
import type { FlareMoEnv } from "../env";

// The weekly review's language model (fork-owned add-on,
// docs/planning-cockpit-goals-review.md). Workers AI through the AI binding by
// default; the Worker secret ANTHROPIC_API_KEY switches to Anthropic's Messages
// API. Either way the routes see one small interface: a whole answer, or the
// answer's text as it arrives. The prompts and the parsers are in the domain
// (review-prompts.ts); nothing here knows what is being asked.
//
// Nothing is logged but the provider, the model and the error message: never a
// prompt, an answer or a key.

/** Workers AI's model when FLAREMO_REVIEW_MODEL is unset. */
export const plannerReviewDefaultModel =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Anthropic's model when FLAREMO_REVIEW_ANTHROPIC_MODEL is unset. */
export const plannerReviewDefaultAnthropicModel = "claude-sonnet-5-5";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export type PlannerModelOptions = {
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
};

export type PlannerReviewModel = {
  provider: "workers-ai" | "anthropic";
  model: string;
  /** The whole answer. Throws when the model cannot be reached. */
  complete(
    messages: readonly PlannerChatMessage[],
    options: PlannerModelOptions,
  ): Promise<string>;
  /** The answer's text, piece by piece. Throws like `complete`. */
  stream(
    messages: readonly PlannerChatMessage[],
    options: PlannerModelOptions,
  ): AsyncGenerator<string>;
};

/** The configured model, or null when the review has none (it then uses its own drafts). */
export function plannerReviewModel(env: FlareMoEnv): PlannerReviewModel | null {
  if (env.FLAREMO_REVIEW_AI?.trim().toLowerCase() === "off") return null;
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) {
    return anthropicModel(
      key,
      env.FLAREMO_REVIEW_ANTHROPIC_MODEL?.trim() ||
        plannerReviewDefaultAnthropicModel,
    );
  }
  if (env.AI) {
    return workersAiModel(
      env.AI,
      env.FLAREMO_REVIEW_MODEL?.trim() || plannerReviewDefaultModel,
    );
  }
  return null;
}

/** The `data:` payloads of a server-sent event stream, one per line. */
async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
        end = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const last = buffer.trim();
    if (last.startsWith("data:")) yield last.slice(5).trim();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Workers AI answers `{response}`; a model in OpenAI's shape answers `choices`. */
function workersAiText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (typeof record.response === "string") return record.response;
  // A JSON answer can come back already parsed.
  if (record.response && typeof record.response === "object") {
    return JSON.stringify(record.response);
  }
  const content = record.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/** One streamed piece of Workers AI text: `{response}` or OpenAI's `delta`. */
function workersAiDelta(payload: string): string {
  const parsed = parseJson(payload) as {
    response?: unknown;
    choices?: Array<{ delta?: { content?: unknown } }>;
  } | null;
  if (!parsed) return "";
  if (typeof parsed.response === "string") return parsed.response;
  const content = parsed.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : "";
}

function workersAiModel(ai: Ai, model: string): PlannerReviewModel {
  const inputs = (
    messages: readonly PlannerChatMessage[],
    options: PlannerModelOptions,
    stream: boolean,
  ) => ({
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    ...(stream ? { stream: true } : {}),
  });
  return {
    provider: "workers-ai",
    model,
    async complete(messages, options) {
      const result = await ai.run(
        model as never,
        inputs(messages, options, false) as never,
        { signal: options.signal } as never,
      );
      return workersAiText(result);
    },
    async *stream(messages, options) {
      const result = (await ai.run(
        model as never,
        inputs(messages, options, true) as never,
        { signal: options.signal } as never,
      )) as unknown;
      if (!(result instanceof ReadableStream)) {
        // A binding that ignored `stream` answered in one piece.
        const whole = workersAiText(result);
        if (whole) yield whole;
        return;
      }
      for await (const payload of sseData(
        result as ReadableStream<Uint8Array>,
        options.signal,
      )) {
        if (payload === "[DONE]") return;
        const text = workersAiDelta(payload);
        if (text) yield text;
      }
    },
  };
}

/** Anthropic takes the system prompt apart from the turns, which start with the user. */
function anthropicBody(
  model: string,
  messages: readonly PlannerChatMessage[],
  options: PlannerModelOptions,
  stream: boolean,
) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const turns = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
  return JSON.stringify({
    model,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    ...(system ? { system } : {}),
    messages: turns,
    ...(stream ? { stream: true } : {}),
  });
}

class PlannerModelError extends Error {
  constructor(provider: string, status: number) {
    super(`${provider} answered ${status}`);
    this.name = "PlannerModelError";
  }
}

function anthropicModel(apiKey: string, model: string): PlannerReviewModel {
  const send = (body: string, signal?: AbortSignal) =>
    fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body,
      signal,
    });
  return {
    provider: "anthropic",
    model,
    async complete(messages, options) {
      const response = await send(
        anthropicBody(model, messages, options, false),
        options.signal,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new PlannerModelError("anthropic", response.status);
      }
      const parsed = (await response.json()) as {
        content?: Array<{ type?: string; text?: unknown }>;
      };
      return (parsed.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .join("");
    },
    async *stream(messages, options) {
      const response = await send(
        anthropicBody(model, messages, options, true),
        options.signal,
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new PlannerModelError("anthropic", response.status);
      }
      for await (const payload of sseData(response.body, options.signal)) {
        const event = parseJson(payload) as {
          type?: string;
          delta?: { type?: string; text?: unknown };
          error?: { type?: string };
        } | null;
        if (!event) continue;
        if (event.type === "error") {
          throw new Error(
            `anthropic stream error: ${event.error?.type ?? "unknown"}`,
          );
        }
        if (event.type === "message_stop") return;
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          yield event.delta.text;
        }
      }
    },
  };
}

/** One line for the Worker's log when a model call fails: no prompt, no answer. */
export function plannerLogModelError(
  model: PlannerReviewModel,
  task: string,
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Weekly review model call failed",
      provider: model.provider,
      model: model.model,
      task,
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    }),
  );
}
