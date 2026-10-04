// Non-exiting transport over the /memory/mcp JSON-RPC endpoint.
// request() never calls process.exit — the CLI wrapper maps results onto the
// documented exit-code contract.

import { resolveCredentials } from "./credentials.mjs";
import { flaremoHome } from "./paths.mjs";

export const DEFAULT_TIMEOUT_MS = 8000;
export const HOOK_TIMEOUT_MS = 2500;

function responseFailure(status, error, text = "") {
  return {
    ok: false,
    status,
    // A 2xx response whose body cannot be read or parsed is usually a proxy,
    // truncated response, or a temporarily incompatible server. Keep writes
    // retryable instead of treating it as a successful empty result.
    unreachable: status >= 500 || (status >= 200 && status < 300),
    auth: status === 401 || status === 403,
    error: `HTTP ${status}: ${error}${text ? ` (${text.slice(0, 300)})` : ""}`,
  };
}

/**
 * @returns {Promise<{ok:boolean, status:number, data?:any, unreachable?:boolean, auth?:boolean, toolError?:boolean, error?:string}>}
 */
export async function request(
  tool,
  args = {},
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = process.env,
    home = flaremoHome(env),
  } = {},
) {
  const { url, pat } = resolveCredentials(env, home);
  const endpoint = `${url.replace(/\/+$/, "")}/memory/mcp`;
  const headers = { "Content-Type": "application/json" };
  if (pat) headers.Authorization = `Bearer ${pat}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        unreachable: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const status = res.status;
    let text;
    try {
      // The same timeout signal covers the body stream, not only headers.
      text = await res.text();
    } catch (error) {
      return responseFailure(
        status,
        "response body could not be read",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!res.ok) {
      return {
        ok: false,
        status,
        // 5xx = transient server side: callers treat it like a network failure
        // (snapshot fallback for reads, outbox queue for writes). 4xx stays a
        // hard error.
        unreachable: status >= 500,
        auth: status === 401 || status === 403,
        error: `HTTP ${status}: ${text.slice(0, 300)}`,
      };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return responseFailure(
        status,
        "invalid JSON response",
        error instanceof Error ? error.message : String(error),
      );
    }
    // JSON-RPC errors are valid envelopes without a result member. Preserve
    // their hard-error semantics before validating successful result shapes.
    if (data && typeof data === "object" && data.error) {
      return {
        ok: false,
        status,
        error: `MCP ${data.error.code}: ${data.error.message}`,
      };
    }
    if (!data || typeof data !== "object" || !("result" in data)) {
      return responseFailure(status, "MCP response is missing result");
    }
    const result = data.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return responseFailure(status, "MCP response result must be an object");
    }
    if (Object.keys(result).length === 0) {
      return responseFailure(status, "MCP response result is empty");
    }
    const structured =
      "structuredContent" in result ? result.structuredContent : result;
    if (result?.isError || structured?.error) {
      return {
        ok: false,
        status,
        toolError: true,
        error: structured?.error?.message ?? "tool call failed",
      };
    }
    if (
      !structured ||
      typeof structured !== "object" ||
      Array.isArray(structured)
    ) {
      return responseFailure(
        status,
        "MCP response structuredContent must be an object",
      );
    }
    if (Object.keys(structured).length === 0) {
      return responseFailure(status, "MCP response result is empty");
    }
    return { ok: true, status, data: structured };
  } finally {
    clearTimeout(timer);
  }
}
