import type { ShortcutRow } from "@flaremo/db";
import {
  createShortcut,
  deleteShortcut,
  getShortcut,
  listShortcuts,
  updateShortcut,
} from "@flaremo/domain";
import type { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../../context";
import {
  currentJsonError,
  ValidationCurrentError,
} from "../../memos-compat/current-errors";
import {
  currentShortcutResourceName,
  currentUserResourceName,
  normalizeShortcutName,
  optionalString,
  parseUpdateMask,
  readBooleanQuery,
  readBooleanValue,
  readJsonObject,
  requiredString,
  shortcutToDto,
  unwrapResourceBody,
} from "./parsing";

export function registerShortcutRoutes(app: Hono<HonoBindings>) {
  app.get("/users/:user/shortcuts", async (c) => {
    try {
      const context = await getRequestContext(c);
      const parentName = currentUserResourceName(
        c.req.param("user"),
        context.user.id,
      );
      const shortcuts: ShortcutRow[] = await listShortcuts(
        context.db,
        context.user,
        { parentName },
      );
      return c.json({
        shortcuts: shortcuts.map((shortcut) => shortcutToDto(shortcut)),
      });
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.post("/users/:user/shortcuts", async (c) => {
    try {
      const context = await getRequestContext(c);
      const parentName = currentUserResourceName(
        c.req.param("user"),
        context.user.id,
      );
      const raw = await readJsonObject(c);
      const shortcut = unwrapResourceBody(raw, "shortcut");
      const title = requiredString(shortcut.title, "shortcut.title");
      const filter = optionalString(shortcut.filter) ?? "";
      const validateOnly = readBooleanQuery(c, "validateOnly", "validate_only");
      const bodyValidateOnly = readBooleanValue(
        raw.validateOnly ?? raw.validate_only,
        "validateOnly",
      );

      const created: ShortcutRow = await createShortcut(
        context.db,
        context.user,
        {
          parentName,
          title,
          filter,
          validateOnly: validateOnly ?? bodyValidateOnly ?? false,
        },
      );
      return c.json(shortcutToDto(created));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.get("/users/:user/shortcuts/:shortcut", async (c) => {
    try {
      const context = await getRequestContext(c);
      const name = currentShortcutResourceName(
        c.req.param("user"),
        c.req.param("shortcut"),
        context.user.id,
      );
      const shortcut: ShortcutRow = await getShortcut(
        context.db,
        context.user,
        {
          name,
        },
      );
      return c.json(shortcutToDto(shortcut));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.patch("/users/:user/shortcuts/:shortcut", async (c) => {
    try {
      const context = await getRequestContext(c);
      const name = currentShortcutResourceName(
        c.req.param("user"),
        c.req.param("shortcut"),
        context.user.id,
      );
      const raw = await readJsonObject(c);
      const shortcut = unwrapResourceBody(raw, "shortcut");
      const suppliedName = optionalString(shortcut.name);
      if (suppliedName && normalizeShortcutName(suppliedName) !== name) {
        throw new ValidationCurrentError(
          "shortcut.name must match the resource path",
        );
      }
      const updateMask = parseUpdateMask(
        c.req.query("updateMask") ??
          c.req.query("update_mask") ??
          optionalString(raw.updateMask) ??
          optionalString(raw.update_mask),
      );
      const title = optionalString(shortcut.title);
      const filter = optionalString(shortcut.filter);
      if (updateMask.includes("title") && !title) {
        throw new ValidationCurrentError(
          "shortcut.title is required by updateMask",
        );
      }
      if (updateMask.includes("filter") && filter === undefined) {
        throw new ValidationCurrentError(
          "shortcut.filter is required by updateMask",
        );
      }

      const updated: ShortcutRow = await updateShortcut(
        context.db,
        context.user,
        {
          name,
          ...(title !== undefined ? { title } : {}),
          ...(filter !== undefined ? { filter } : {}),
          updateMask,
        },
      );
      return c.json(shortcutToDto(updated));
    } catch (error) {
      return currentJsonError(c, error);
    }
  });

  app.delete("/users/:user/shortcuts/:shortcut", async (c) => {
    try {
      const context = await getRequestContext(c);
      const name = currentShortcutResourceName(
        c.req.param("user"),
        c.req.param("shortcut"),
        context.user.id,
      );
      await deleteShortcut(context.db, context.user, { name });
      return c.body(null, 200);
    } catch (error) {
      return currentJsonError(c, error);
    }
  });
}
