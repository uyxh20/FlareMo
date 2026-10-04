import type { MemoRow, ReactionRow, ShortcutRow, UserRow } from "@flaremo/db";
import { currentShortcutToDto } from "@flaremo/memos";
import type { Context } from "hono";
import type { getOptionalRequestContext, HonoBindings } from "../../context";
import { getFlaremoUserCached } from "../../identity-cache";
import {
  ForbiddenCurrentError,
  ValidationCurrentError,
} from "../../memos-compat/current-errors";
import { isRecord } from "../../memos-compat/errors";

export type MemoVisibility = "private" | "protected" | "public";

export type PageOptions = {
  pageSize: number;
  pageToken?: string;
};

export type MemoCommentPage = {
  memos: MemoRow[];
  nextPageToken?: string;
  totalSize: number;
};

export type MemoReactionPage = {
  reactions: ReactionRow[];
  nextPageToken?: string;
  totalSize: number;
};

export function shortcutToDto(value: ShortcutRow) {
  // The domain row retains a `shortcuts/<id>` storage id. The current adapter
  // strips that storage prefix before constructing the public resource name.
  return currentShortcutToDto(value);
}

/**
 * Resolve the creator row for a hydrating memo, memoizing misses (null) so a
 * deleted author row costs one lookup per memo. Self-mentions reuse the
 * viewer's session row without a D1 round trip.
 */
export async function resolveMemoCreatorRow(
  context: Awaited<ReturnType<typeof getOptionalRequestContext>>,
  creators: Map<string, UserRow | null>,
  memo: MemoRow,
): Promise<UserRow> {
  const cached = creators.get(memo.userId);
  if (cached) return cached;
  const resolved =
    context.user && context.user.id === memo.userId
      ? context.user
      : await getFlaremoUserCached(context.db, memo.userId);
  if (!resolved) {
    creators.set(memo.userId, null);
    throw new Error("Memo creator not found");
  }
  creators.set(memo.userId, resolved);
  return resolved;
}

export function readPageOptions(c: Context<HonoBindings>): PageOptions;
export function readPageOptions(
  c: Context<HonoBindings>,
  defaultOrderBy: string,
): PageOptions & { orderBy: string };
export function readPageOptions(
  c: Context<HonoBindings>,
  defaultOrderBy?: string,
) {
  const rawPageSize = c.req.query("pageSize") ?? c.req.query("page_size");
  const rawPageToken = c.req.query("pageToken") ?? c.req.query("page_token");
  const result: PageOptions & { orderBy?: string } = {
    pageSize: parsePageSize(rawPageSize),
    ...(rawPageToken ? { pageToken: rawPageToken } : {}),
  };
  if (defaultOrderBy !== undefined) {
    result.orderBy = parseOrderBy(
      c.req.query("orderBy") ?? c.req.query("order_by") ?? defaultOrderBy,
    );
  }
  return result;
}

function parsePageSize(value: string | undefined) {
  if (value === undefined || value.trim() === "") return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ValidationCurrentError("pageSize must be an integer");
  }
  if (parsed <= 0) return 50;
  return Math.min(parsed, 1000);
}

function parseOrderBy(value: string) {
  const match = /^(create_time|update_time)\s+(asc|desc)$/i.exec(value.trim());
  if (!match) {
    throw new ValidationCurrentError(
      "Only create_time or update_time with asc or desc is supported",
    );
  }
  return `${match[1]?.toLowerCase()} ${match[2]?.toLowerCase()}`;
}

export function parseUpdateMask(value: string | undefined) {
  const fields = (value ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  if (fields.length === 0) {
    throw new ValidationCurrentError("updateMask is required");
  }
  const expanded = fields.includes("*") ? ["title", "filter"] : fields;
  const unsupported = expanded.filter(
    (field) => field !== "title" && field !== "filter",
  );
  if (unsupported.length > 0) {
    throw new ValidationCurrentError(
      `Unsupported shortcut updateMask field: ${unsupported[0]}`,
    );
  }
  return [...new Set(expanded)];
}

export function readBooleanQuery(
  c: Context<HonoBindings>,
  primary: string,
  legacy: string,
) {
  const value = c.req.query(primary) ?? c.req.query(legacy);
  return value === undefined ? undefined : parseBoolean(value, primary);
}

export function readBooleanValue(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return parseBoolean(value, field);
  throw new ValidationCurrentError(`${field} must be a boolean`);
}

function parseBoolean(value: string, field: string) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ValidationCurrentError(`${field} must be a boolean`);
}

export async function readJsonObject(c: Context<HonoBindings>) {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new ValidationCurrentError("Request body must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new ValidationCurrentError("Request body must be a JSON object");
  }
  return value;
}

export function unwrapResourceBody(
  body: Record<string, unknown>,
  resource: "comment" | "reaction" | "shortcut",
) {
  const nested = body[resource];
  if (nested !== undefined && !isRecord(nested)) {
    throw new ValidationCurrentError(`${resource} must be an object`);
  }
  return isRecord(nested) ? nested : body;
}

export function memoPayload(body: Record<string, unknown>) {
  const payload = isRecord(body.payload) ? { ...body.payload } : {};
  if (Array.isArray(body.tags)) {
    payload.tags = body.tags.filter(
      (tag): tag is string => typeof tag === "string",
    );
  }
  if (isRecord(body.property)) {
    payload.property = {
      ...(typeof body.property.title === "string"
        ? { title: body.property.title }
        : {}),
      ...(typeof body.property.hasLink === "boolean"
        ? { has_link: body.property.hasLink }
        : {}),
      ...(typeof body.property.hasTaskList === "boolean"
        ? { has_task_list: body.property.hasTaskList }
        : {}),
      ...(typeof body.property.hasCode === "boolean"
        ? { has_code: body.property.hasCode }
        : {}),
      ...(typeof body.property.hasIncompleteTasks === "boolean"
        ? { has_incomplete_tasks: body.property.hasIncompleteTasks }
        : {}),
    };
  }
  if (isRecord(body.location)) payload.location = { ...body.location };
  return payload;
}

export function parseVisibility(value: unknown): MemoVisibility {
  const normalized =
    typeof value === "string" ? value.toLowerCase() : "private";
  if (normalized === "visibility_unspecified") return "private";
  if (
    normalized === "private" ||
    normalized === "protected" ||
    normalized === "public"
  ) {
    return normalized;
  }
  throw new ValidationCurrentError(
    `Unsupported memo visibility: ${String(value)}`,
  );
}

export function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationCurrentError(`${field} is required`);
  }
  return value.trim();
}

export function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function normalizeMemoName(value: string) {
  const normalized = value.startsWith("memos/") ? value : `memos/${value}`;
  if (normalized.split("/").length !== 2 || normalized.endsWith("/")) {
    throw new ValidationCurrentError("Invalid memo resource name");
  }
  return normalized;
}

export function currentUserResourceName(value: string, currentUserId: string) {
  const normalized = stripUserPrefix(value);
  const expected = stripUserPrefix(currentUserId);
  if (!normalized || normalized !== expected) {
    throw new ForbiddenCurrentError("Only the current user is available");
  }
  return currentUserId.startsWith("users/")
    ? currentUserId
    : `users/${currentUserId}`;
}

export function currentShortcutResourceName(
  user: string,
  shortcut: string,
  currentUserId: string,
) {
  const parentName = currentUserResourceName(user, currentUserId);
  const shortcutId = requiredPathSegment(shortcut, "shortcut");
  return `${parentName}/shortcuts/${shortcutId}`;
}

export function normalizeShortcutName(value: string) {
  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "users" || parts[2] !== "shortcuts") {
    throw new ValidationCurrentError("Invalid shortcut resource name");
  }
  requiredPathSegment(parts[1] ?? "", "user");
  requiredPathSegment(parts[3] ?? "", "shortcut");
  return value;
}

function stripUserPrefix(value: string) {
  const decoded = decodePathSegment(value);
  return decoded.startsWith("users/")
    ? decoded.slice("users/".length)
    : decoded;
}

export function requiredPathSegment(value: string, field: string) {
  const decoded = decodePathSegment(value);
  if (!decoded || decoded.includes("/")) {
    throw new ValidationCurrentError(`${field} is required`);
  }
  return decoded;
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ValidationCurrentError("Invalid resource path");
  }
}
