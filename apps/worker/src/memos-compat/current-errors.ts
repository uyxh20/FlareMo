/**
 * Error envelope for the "current" Memos wire surface, shared by the
 * routes/memos-current tree (protobuf-JSON REST) and the routes/social tree
 * (comments / reactions / shortcuts). Both answer errors with the same
 * `{ code, message, details }` body — a protobuf status code, a
 * caller-facing message, and an empty details list.
 *
 * The two trees used to carry a private copy each, and the copies had
 * drifted: the social copy never learned the CompatValidationError /
 * credential-error / schema-issues classifications (those all degraded to
 * 500), and only the memos-current copy mapped 429 to RESOURCE_EXHAUSTED.
 * The union below is the single implementation. Classification still
 * delegates to memos-compat/errors; this module only owns the envelope and
 * the current-surface HTTP error classes.
 */
import type { Context } from "hono";
import type { HonoBindings } from "../context";
import {
  CompatValidationError,
  controlledErrorStatus,
  isBetterAuthCredentialError,
  isDomainError,
  isRecord,
} from "./errors";

export function currentJsonError(c: Context<HonoBindings>, error: unknown) {
  const status = currentErrorStatus(error);
  return c.json(
    {
      code: currentErrorCode(status),
      message: currentErrorMessage(error),
      details: [],
    },
    status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500,
  );
}

function currentErrorStatus(error: unknown) {
  if (error instanceof CurrentHttpError) return error.status;
  if (error instanceof CompatValidationError) return 400;
  if (isDomainError(error)) return error.status;
  if (isBetterAuthCredentialError(error)) return 400;
  if (isRecord(error) && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  if (isRecord(error) && typeof error.status === "number") {
    return error.status;
  }
  if (isRecord(error) && Array.isArray(error.issues)) return 400;
  console.error(
    JSON.stringify({
      level: "error",
      message: "Unhandled current Memos compatibility request error",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return 500;
}

function currentErrorMessage(error: unknown) {
  if (error instanceof CurrentHttpError) return error.message;
  if (error instanceof CompatValidationError) return error.message;
  if (isDomainError(error)) return error.message;
  if (isBetterAuthCredentialError(error)) {
    return "unmatched username and password";
  }
  // Framework errors (Better Auth, transport codecs) carry controlled,
  // caller-facing messages alongside their status. Everything else without a
  // domain type — D1 failures, TypeErrors — stays generic so internal
  // details never reach the response body.
  if (controlledErrorStatus(error) !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  if (isRecord(error) && Array.isArray(error.issues)) {
    return error.issues
      .map((issue) =>
        isRecord(issue) && typeof issue.message === "string"
          ? issue.message
          : "Invalid request",
      )
      .join("; ");
  }
  return "Internal server error";
}

/** Protobuf status codes: INVALID_ARGUMENT=3, NOT_FOUND=5, ALREADY_EXISTS=6,
 * PERMISSION_DENIED=7, RESOURCE_EXHAUSTED=8, UNAUTHENTICATED=16, INTERNAL=13.
 */
function currentErrorCode(status: number) {
  if (status === 400 || status === 422) return 3;
  if (status === 401) return 16;
  if (status === 403) return 7;
  if (status === 404) return 5;
  if (status === 409) return 6;
  if (status === 413) return 8;
  if (status === 429) return 8;
  return 13;
}

/**
 * HTTP error carrying its own status: the escape hatch for handlers whose
 * failure is not a domain error type. Input validation problems should
 * prefer CompatValidationError (the canonical 400 on every compat surface).
 */
export class CurrentHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ValidationCurrentError extends CurrentHttpError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ForbiddenCurrentError extends CurrentHttpError {
  constructor(message: string) {
    super(message, 403);
  }
}
