import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./auth-fixture";
import { createMemoryViaComposer } from "./workspace-helpers";

test("creates a memory and locks it", async ({ page }) => {
  const content = `FlareMo 使用 D1 作为事实源 #mem${Date.now()}`;

  await page.goto("/memory");

  // Memories are filed through the page's inline quick composer, not a modal.
  // Create it as a preference rather than the default iron rule so the lock
  // step below has something to do — the iron-rule tier locks on creation.
  await createMemoryViaComposer(page, content, "preference");

  // The review/confirmed split is now a row of filter pills rather than tabs;
  // "全部" shows every tier, which is where a freshly composed memory lands.
  // The pill renders its label next to a count, so the accessible name reads
  // "全部 3" / "All 3" — match the label as a whole word, not the whole name.
  await page
    .getByRole("button", { name: /\b全部\b|\bAll\b/ })
    .first()
    .click();
  await expect(page.getByText(content)).toBeVisible();

  // Locking ("钉住铁律" / "Pin as rule") is one of the card's overflow-menu
  // actions; it flips the verification badge to the locked state, after which
  // the menu offers the inverse.
  await page
    .getByRole("button", { name: /^Actions$|^操作$/i })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: /Pin as rule|钉住铁律/i })
    .first()
    .click();
  await expect(page.getByText(/^My call$|^我拍板的$/).first()).toBeVisible();
});

test("lists a memory created through the API", async ({ page, request }) => {
  const content = `API-created memory #api${Date.now()}`;
  await request.post("/api/app/memory", {
    headers: { origin: E2E_BASE_URL },
    data: {
      content,
      type: "semantic",
      kind: "decision",
      scope_type: "project",
      scope_key: "github:realchendahuang/FlareMo",
      tier: "core",
      importance: 90,
    },
  });

  await page.goto("/memory");
  await expect(page.getByText(content)).toBeVisible();
});

test("edits a memory from the memory card", async ({ page }) => {
  const content = `待编辑的记忆 #edit${Date.now()}`;
  const updated = `编辑后的记忆 #edit${Date.now()}`;

  await page.goto("/memory");
  await createMemoryViaComposer(page, content);

  // The pill renders its label next to a count, so the accessible name reads
  // "全部 3" / "All 3" — match the label as a whole word, not the whole name.
  await page
    .getByRole("button", { name: /\b全部\b|\bAll\b/ })
    .first()
    .click();
  await expect(page.getByText(content)).toBeVisible();

  // The edit action lives in the memory card's overflow menu. Scope to the
  // card holding this test's memory: a full-suite run has other memories on
  // the page, and an unscoped `.first()` opens the wrong card's menu.
  const card = page.locator("article").filter({ hasText: content });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /actions|操作/i }).click();
  await page.getByRole("menuitem", { name: /^edit$|^编辑$/i }).click();
  const editDialog = page.locator('[role="dialog"]:visible').last();
  await editDialog.locator("textarea").fill(updated);
  await editDialog.getByRole("button", { name: /save|保存/i }).click();

  await expect(page.getByText(updated)).toBeVisible();
  await expect(page.getByText(content)).not.toBeVisible();
});
