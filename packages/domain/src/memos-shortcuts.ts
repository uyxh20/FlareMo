import type { FlareMoDb, ShortcutRow, UserRow } from "@flaremo/db";
import { shortcuts } from "@flaremo/db";
import { and, asc, eq } from "drizzle-orm";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { compileMemoFilter } from "./memo-filter";
import { createSocialResourceId } from "./memos-social-shared";

export type CreateShortcutInput = {
  parentName?: string;
  title?: string;
  filter?: string;
  parent?: string;
  shortcut?: { title: string; filter?: string };
  validateOnly?: boolean;
};

export type UpdateShortcutInput = {
  name?: string;
  title?: string;
  filter?: string;
  updateMask?: string | string[];
  shortcut?: { name?: string; title?: string; filter?: string };
};

export type SocialShortcutRow = ShortcutRow & { name: string };

export function listShortcuts(
  db: FlareMoDb,
  user: UserRow,
  parent: string,
): Promise<SocialShortcutRow[]>;
export function listShortcuts(
  db: FlareMoDb,
  user: UserRow,
  input: { parentName: string },
): Promise<SocialShortcutRow[]>;
export async function listShortcuts(
  db: FlareMoDb,
  user: UserRow,
  parentOrInput: string | { parentName: string } = user.id,
): Promise<SocialShortcutRow[]> {
  const parent =
    typeof parentOrInput === "string"
      ? parentOrInput
      : parentOrInput.parentName;
  assertUserResourceName(parent, user);
  const rows = await db
    .select()
    .from(shortcuts)
    .where(eq(shortcuts.userId, user.id))
    .orderBy(asc(shortcuts.createdAt), asc(shortcuts.id));
  return rows.map(withShortcutResourceName);
}

export function getShortcut(
  db: FlareMoDb,
  user: UserRow,
  name: string,
): Promise<SocialShortcutRow>;
export function getShortcut(
  db: FlareMoDb,
  user: UserRow,
  input: { name: string },
): Promise<SocialShortcutRow>;
export async function getShortcut(
  db: FlareMoDb,
  user: UserRow,
  nameOrInput: string | { name: string },
): Promise<SocialShortcutRow> {
  const name = typeof nameOrInput === "string" ? nameOrInput : nameOrInput.name;
  const id = parseShortcutResourceName(name, user);
  const row = await db
    .select()
    .from(shortcuts)
    .where(and(eq(shortcuts.id, id), eq(shortcuts.userId, user.id)))
    .get();
  if (!row) throw new NotFoundError("Shortcut not found");
  return withShortcutResourceName(row);
}

export async function createShortcut(
  db: FlareMoDb,
  user: UserRow,
  input: CreateShortcutInput,
): Promise<SocialShortcutRow> {
  if (input.parentName) assertUserResourceName(input.parentName, user);
  if (input.parent) assertUserResourceName(input.parent, user);
  const title = (input.shortcut?.title ?? input.title ?? "").trim();
  const filter = (input.shortcut?.filter ?? input.filter ?? "").trim();
  await validateShortcut(title, filter);
  const now = new Date().toISOString();
  const row = {
    id: createSocialResourceId("shortcuts"),
    userId: user.id,
    title,
    filter,
    createdAt: now,
    updatedAt: now,
  };
  if (input.validateOnly) return withShortcutResourceName(row);
  await db.insert(shortcuts).values(row);
  return getShortcut(db, user, row.id);
}

export function updateShortcut(
  db: FlareMoDb,
  user: UserRow,
  input: UpdateShortcutInput,
): Promise<SocialShortcutRow>;
export function updateShortcut(
  db: FlareMoDb,
  user: UserRow,
  name: string,
  input: UpdateShortcutInput,
): Promise<SocialShortcutRow>;
export async function updateShortcut(
  db: FlareMoDb,
  user: UserRow,
  nameOrInput: string | UpdateShortcutInput,
  input?: UpdateShortcutInput,
): Promise<SocialShortcutRow> {
  const effectiveInput =
    typeof nameOrInput === "string" ? (input ?? {}) : nameOrInput;
  const name =
    typeof nameOrInput === "string"
      ? nameOrInput
      : (effectiveInput.shortcut?.name ?? effectiveInput.name ?? "");
  const resourceName =
    effectiveInput.shortcut?.name ?? effectiveInput.name ?? name;
  const existing = await getShortcut(db, user, resourceName);
  const updateMask = normalizeUpdateMask(effectiveInput.updateMask);
  const updatesTitle = !updateMask || updateMask.includes("title");
  const updatesFilter = !updateMask || updateMask.includes("filter");
  const title = updatesTitle
    ? (
        effectiveInput.shortcut?.title ??
        effectiveInput.title ??
        existing.title
      ).trim()
    : existing.title;
  const filter = updatesFilter
    ? (
        effectiveInput.shortcut?.filter ??
        effectiveInput.filter ??
        existing.filter
      ).trim()
    : existing.filter;
  await validateShortcut(title, filter);
  const now = new Date().toISOString();
  await db
    .update(shortcuts)
    .set({ title, filter, updatedAt: now })
    .where(and(eq(shortcuts.id, existing.id), eq(shortcuts.userId, user.id)));
  return getShortcut(db, user, existing.id);
}

export function deleteShortcut(
  db: FlareMoDb,
  user: UserRow,
  input: { name: string },
): Promise<void>;
export function deleteShortcut(
  db: FlareMoDb,
  user: UserRow,
  name: string,
): Promise<void>;
export async function deleteShortcut(
  db: FlareMoDb,
  user: UserRow,
  nameOrInput: string | { name: string },
): Promise<void> {
  const name = typeof nameOrInput === "string" ? nameOrInput : nameOrInput.name;
  const existing = await getShortcut(db, user, name);
  await db
    .delete(shortcuts)
    .where(and(eq(shortcuts.id, existing.id), eq(shortcuts.userId, user.id)));
}

function withShortcutResourceName(row: ShortcutRow): SocialShortcutRow {
  const shortcutId = row.id.replace(/^shortcuts\//, "");
  return { ...row, name: `${row.userId}/shortcuts/${shortcutId}` };
}

function assertUserResourceName(name: string, user: UserRow) {
  const normalized = normalizeUserResourceName(name);
  if (normalized !== user.id) {
    throw new ForbiddenError("Only the current user is available");
  }
}

function normalizeUserResourceName(name: string) {
  if (name.startsWith("users/")) return name;
  return `users/${name}`;
}

function parseShortcutResourceName(name: string, user: UserRow) {
  const parts = name.split("/").filter(Boolean);
  if (parts.length === 4 && parts[0] === "users" && parts[2] === "shortcuts") {
    assertUserResourceName(`users/${parts[1]}`, user);
    if (!parts[3]) throw new ValidationError("Invalid shortcut name");
    return `shortcuts/${parts[3]}`;
  }
  if (name.startsWith("shortcuts/") && name.split("/").length === 2) {
    return name;
  }
  throw new ValidationError("Invalid shortcut name");
}

function normalizeUpdateMask(mask: string | string[] | undefined) {
  if (mask === undefined) return undefined;
  const values = Array.isArray(mask) ? mask : mask.split(",");
  const normalized = values
    .map((value) => value.trim())
    .filter(
      (value): value is "title" | "filter" =>
        value === "title" || value === "filter",
    );
  if (normalized.length !== values.filter((value) => value.trim()).length) {
    throw new ValidationError("Unsupported shortcut update mask");
  }
  return normalized;
}

async function validateShortcut(title: string, filter: string) {
  if (!title) throw new ValidationError("Shortcut title is required");
  if (title.length > 256)
    throw new ValidationError("Shortcut title is too long");
  if (!filter) throw new ValidationError("Shortcut filter is required");
  if (filter.length > 4_096)
    throw new ValidationError("Shortcut filter is too long");
  if (filter) await compileMemoFilter(filter);
}
