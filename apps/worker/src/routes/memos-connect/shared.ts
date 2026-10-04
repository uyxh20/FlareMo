import type { createDb, UserRow } from "@flaremo/db";
import { SELF_HOST_UNLIMITED } from "@flaremo/domain";
import type { Context } from "hono";
import {
  getFlareMoDb,
  type getOptionalRequestContext,
  type getRequestContext,
  type HonoBindings,
} from "../../context";
import { memoFilterScanLimit } from "../../filter-scan-limit";
import { getAuthUserCached, getFlaremoUserCached } from "../../identity-cache";
import { base64ToUint8Array } from "../../memos-compat/base64";
import { CompatValidationError } from "../../memos-compat/errors";
import { parseMemosPageSize } from "../../memos-compat/parsing";
export type ConnectContext = Context<HonoBindings>;

export type ConnectRequestContext = Awaited<
  ReturnType<typeof getRequestContext>
>;
export type ConnectReadContext = Awaited<
  ReturnType<typeof getOptionalRequestContext>
>;

export function attachmentBytes(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") {
    try {
      return base64ToUint8Array(value);
    } catch {
      throw new CompatValidationError(
        "attachment.content must be valid base64",
      );
    }
  }
  return new Uint8Array();
}

export function fieldMaskPaths(value: unknown) {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
  }
  const paths = record(value).paths;
  return Array.isArray(paths)
    ? paths.filter(
        (path): path is string =>
          typeof path === "string" && Boolean(path.trim()),
      )
    : [];
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function list(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function connectSettingRecord(value: unknown) {
  const setting = record(value);
  if (setting.value !== undefined) return setting;
  for (const caseName of [
    "generalSetting",
    "storageSetting",
    "memoRelatedSetting",
    "tagsSetting",
    "notificationSetting",
    "aiSetting",
    "webhooksSetting",
  ]) {
    if (Object.hasOwn(setting, caseName)) {
      return {
        ...setting,
        value: { case: caseName, value: setting[caseName] },
      };
    }
  }
  return setting;
}

export function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim())
    throw new CompatValidationError(`${field} is required`);
  return value.trim();
}

export function optionalTimestamp(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = requiredString(value, field);
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new CompatValidationError(`${field} must be a valid timestamp`);
  }
  return date.toISOString();
}
export async function getPublicInstanceContext(
  c: ConnectContext,
): Promise<ConnectRequestContext> {
  const db = getFlareMoDb(c.env);
  const user =
    (await getFlaremoUserCached(db, "users/owner")) ??
    publicOwnerFallback(c.env.FLAREMO_SINGLE_USER_NAME);
  return {
    db,
    user,
    authUserId: "",
    credential: "session",
    bearerSession: false,
    nativeAccessToken: false,
    session: null,
    authUser: undefined,
    memoFilterScanLimit: memoFilterScanLimit(c.env),
    limits: SELF_HOST_UNLIMITED,
    userLimits: null,
  };
}

export function publicOwnerFallback(name: string | undefined): UserRow {
  const timestamp = new Date(0).toISOString();
  return {
    id: "users/owner",
    email: "",
    name: name?.trim() || "Owner",
    avatarUrl: null,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
export async function getAuthUserForContext(
  context: Awaited<ReturnType<typeof getRequestContext>>,
) {
  return getAuthUserCached(context.db, context.authUserId);
}

export async function getUserByName(
  db: ReturnType<typeof createDb>,
  name: unknown,
) {
  const value = requiredString(name, "name");
  const id = value.startsWith("users/") ? value : `users/${value}`;
  return getFlaremoUserCached(db, id);
}

export function pageSize(value: unknown) {
  if (value === undefined) return 50;
  const parsed = parseMemosPageSize(value);
  if (parsed === null)
    throw new CompatValidationError("pageSize must be a positive integer");
  return Math.min(parsed, 1_000);
}
