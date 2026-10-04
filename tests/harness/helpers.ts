// Shared test helpers for harness adapter tests.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI = join(import.meta.dirname, "..", "..", "bin", "flaremo");

export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeServer {
  url: string;
  calls: FakeCall[];
  server: Server;
  close: () => Promise<void>;
  /** Mutate behavior between requests. */
  mode: {
    status: number;
    payload?: unknown;
    rawBody?: string;
    delayMs?: number;
  };
}

/** A local JSON-RPC endpoint that mimics /memory/mcp. */
export async function fakeMcpServer(
  responses: Record<string, unknown> = {},
): Promise<FakeServer> {
  const calls: FakeCall[] = [];
  const mode = {
    status: 200,
    payload: undefined as unknown,
    rawBody: undefined as string | undefined,
    delayMs: 0,
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: {
        params?: { name?: string; arguments?: Record<string, unknown> };
        id?: unknown;
      } = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const tool = parsed?.params?.name ?? "";
      calls.push({ tool, args: parsed?.params?.arguments ?? {} });
      if (mode.status !== 200) {
        res.writeHead(mode.status, { "Content-Type": "text/plain" });
        res.end("nope");
        return;
      }
      const data =
        mode.payload !== undefined
          ? mode.payload
          : (responses[tool] ?? { ok: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      const responseBody =
        mode.rawBody ??
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed?.id ?? 1,
          result: { structuredContent: data },
        });
      if (mode.delayMs) {
        // Make the header/body boundary observable so timeout tests exercise
        // res.text(), rather than a timeout waiting for fetch() headers.
        res.flushHeaders();
        setTimeout(() => res.end(responseBody), mode.delayMs);
      } else {
        res.end(responseBody);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    server,
    mode: mode as FakeServer["mode"],
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function tmpHome() {
  return mkdtempSync(join(tmpdir(), "flaremo-test-"));
}

export function makeEnv(home: string, url: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FLAREMO_PROJECT;
  delete env.FLAREMO_AGENT;
  delete env.FLAREMO_IDEMPOTENCY_KEY;
  env.FLAREMO_HOME = home;
  env.FLAREMO_URL = url;
  env.FLAREMO_PAT = "test-pat";
  return env;
}

/**
 * Run `node bin/flaremo <args>` with stdin, return {stdout, status}.
 * Must be async: execFileSync would block the test process's event loop and
 * starve the in-process fake MCP server the child needs to reach.
 */
export function runCli(
  args: string[],
  { env, input = "" }: { env: NodeJS.ProcessEnv; input?: string },
): Promise<{ stdout: string; status: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env, timeout: 15_000, encoding: "utf-8" },
      (error, stdout) => {
        resolve({
          stdout: stdout ?? "",
          status: error ? (error.code ?? 1) : 0,
        });
      },
    );
    child.stdin?.end(input);
  });
}

export function writeFile(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}
