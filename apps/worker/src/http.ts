import { DomainError } from "@flaremo/domain";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HonoBindings } from "./context";
import { controlledErrorStatus } from "./memos-compat/errors";

export function jsonError(c: Context<HonoBindings>, error: unknown) {
  if (error instanceof DomainError) {
    return c.json(
      { error: { message: error.message } },
      toContentfulStatus(error.status),
    );
  }

  // Framework errors that carry their own 4xx — Better Auth's APIError is the
  // main source — are client mistakes with a caller-facing message, and
  // flattening them into "Internal server error" hid real causes like a
  // duplicate email. Only 4xx and only a non-empty message qualify; anything
  // else keeps the generic body so driver and internal detail cannot leak.
  const controlledStatus = controlledErrorStatus(error);
  if (controlledStatus !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return c.json(
        { error: { message } },
        toContentfulStatus(controlledStatus),
      );
    }
  }

  console.error(
    JSON.stringify({
      level: "error",
      message: "Unhandled request error",
      error: serializeError(error),
    }),
  );
  return c.json({ error: { message: "Internal server error" } }, 500);
}

function toContentfulStatus(status: number): ContentfulStatusCode {
  if (status >= 200 && status < 300) {
    return 400;
  }
  if (status === 101 || status === 204 || status === 205 || status === 304) {
    return 500;
  }
  if (status >= 100 && status <= 599) {
    return status as ContentfulStatusCode;
  }
  return 500;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
