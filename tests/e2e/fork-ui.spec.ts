import { expect, test } from "@playwright/test";

// The fork's small UI changes (docs/fork-customizations.md): three sidebar
// entries hidden. Registered in the opt-in memo-ui project through the regex in
// playwright.config.ts and, like every e2e spec here, written to be run only
// when the maintainer asks for it (AGENTS.md: e2e is opt-in).
//
// Both languages are matched everywhere, as the other specs do.

test("the sidebar hides Team projects, Projects and Articles but keeps the rest", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: /^(Navigation|导航)$/ });
  await expect(
    nav.getByRole("link", { name: /^(All memos|全部记录)$/ }),
  ).toBeVisible();
  await expect(
    nav.getByRole("link", { name: /^(Cockpit|驾驶舱)$/ }),
  ).toBeVisible();
  await expect(
    nav.getByRole("link", { name: /^(On this day|往年今日)$/ }),
  ).toBeVisible();
  await expect(
    nav.getByRole("link", { name: /^(Memory|记忆)$/ }),
  ).toBeVisible();

  for (const route of ["/team-projects", "/projects", "/articles"]) {
    await expect(nav.locator(`a[href="${route}"]`)).toHaveCount(0);
  }
});

test("the hidden pages still open by their URL", async ({ page }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(
    page.getByRole("heading", { level: 1, name: /^(Projects|项目)$/ }),
  ).toBeVisible();
});
