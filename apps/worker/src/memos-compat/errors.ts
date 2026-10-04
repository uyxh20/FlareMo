/**
 * Shared error classification for the Memos compatibility surfaces
 * (routes/memos-api.ts, routes/memos-current-api.ts,
 * routes/memos-connect-api.ts).
 *
 * The domain layer owns the single error model (@flaremo/domain DomainError
 * and its status subclasses); the protocol adapters own only their envelope
 * mapping. This module is the one place that decides whether an arbitrary
 * thrown value IS a domain error, and carries the two adapter-level
 * validation helpers every surface used to re-declare locally
 * (ConnectInputError / ValidationCurrentError). Each adapter maps the
 * classified error into its own wire envelope; the mapping functions live in
 * the adapters and never re-classify.
 */
import { DomainError } from "@flaremo/domain";

/**
 * Client-facing input validation error raised by the compat handlers before
 * anything reaches the domain layer. Maps to HTTP 400 on every surface:
 * Connect `invalid_argument`, current `code: 3`, legacy error envelope.
 */
export class CompatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompatValidationError";
  }
}

/**
 * Canonical domain-error classifier. Replaces the two divergent copies that
 * used to live in the Connect and current adapters (one required
 * `error instanceof Error`, the other duck-typed any object with a numeric
 * status — the difference silently changed how non-Error status carriers
 * were mapped).
 */
export function isDomainError(error: unknown): error is DomainError {
  return (
    error instanceof DomainError ||
    (error instanceof Error &&
      "status" in error &&
      typeof error.status === "number")
  );
}

/**
 * Narrow an unknown input to a plain object record (not `null`, not an
 * array). The compat surfaces each re-declared this guard locally; keep the
 * single copy next to the other shared classifiers.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The HTTP status a framework error carries itself, or null when it is not a
 * controlled caller-facing failure. Better Auth's APIError exposes both
 * `statusCode` (numeric) and `status` (numeric or a name), so either is
 * accepted; only 4xx qualifies. 5xx and status-less errors are deliberately
 * excluded — their messages can carry driver or internal detail, so every
 * envelope keeps answering those generically.
 */
export function controlledErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const status =
    typeof error.statusCode === "number"
      ? error.statusCode
      : typeof error.status === "number"
        ? error.status
        : null;
  return status !== null && status >= 400 && status < 500 ? status : null;
}

/**
 * Status carried by a Better Auth HTTP rejection: 4xx keeps its own message,
 * everything else is not a controlled error.
 */
export { isBetterAuthCredentialError } from "./credential";
