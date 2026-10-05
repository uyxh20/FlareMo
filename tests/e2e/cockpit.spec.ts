import { expect, type Page, test } from "@playwright/test";
import { startWithCleanClientState } from "./workspace-helpers";

// The planning cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 5 and 6). Registered in
// the opt-in memo-ui project through the regex in playwright.config.ts, and, like
// every e2e spec here, written to be run only when the maintainer asks for it
// (AGENTS.md: e2e is opt-in).
//
// Both languages are matched everywhere, as the other specs do: the app follows
// the browser's language and the cockpit's own copy has English and Chinese.

const COLUMN = {
  backlog: /^(待规划|Backlog)$/,
  todo: /^(待办|To Do)$/,
  doing: /^(进行中|Doing)$/,
  done: /^(已完成|Done)$/,
};

const column = (page: Page, name: RegExp) => page.getByRole("region", { name });

const card = (page: Page, column_: RegExp, title: string) =>
  column(page, column_).getByTestId("planner-card").filter({ hasText: title });

test("anonymous cockpit deep link keeps its destination through sign-in", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/cockpit");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  const redirected = new URL(page.url()).searchParams.get("redirect");
  expect(redirected).toBe("/cockpit");
});

test("the cockpit deep link opens the board and survives a refresh", async ({
  page,
}) => {
  await page.goto("/cockpit");
  await expect(
    page.getByRole("heading", { level: 1, name: /^(驾驶舱|Cockpit)$/ }),
  ).toBeVisible();
  for (const name of Object.values(COLUMN)) {
    await expect(column(page, name)).toBeVisible();
  }
  await expect(page).toHaveURL(/\/cockpit$/);

  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: /^(驾驶舱|Cockpit)$/ }),
  ).toBeVisible();
  await expect(column(page, COLUMN.todo)).toBeVisible();
});

test("the sidebar links to the cockpit", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: /^(驾驶舱|Cockpit)$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/cockpit$/);
  await expect(column(page, COLUMN.todo)).toBeVisible();
});

test("quick add puts a task in To Do, planned for Today", async ({ page }) => {
  await startWithCleanClientState(page);
  const title = `Cockpit quick add ${Date.now()}`;

  await page.goto("/cockpit");
  const input = page.getByRole("textbox", { name: /^(新任务|New task)$/ });
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press("Enter");

  const added = card(page, COLUMN.todo, title);
  await expect(added).toBeVisible();
  // The chip is the plan: Today is quick add's default.
  await expect(added.getByText(/^(今天|Today)$/)).toBeVisible();
  // The field empties so the next task can be typed straight away.
  await expect(input).toHaveValue("");

  // It is on the server, not only on the screen.
  await page.reload();
  await expect(card(page, COLUMN.todo, title)).toBeVisible();
});

test("a card moves to Doing from its menu and stays there", async ({
  page,
}) => {
  const title = `Cockpit move ${Date.now()}`;

  await page.goto("/cockpit");
  const input = page.getByRole("textbox", { name: /^(新任务|New task)$/ });
  await input.fill(title);
  await input.press("Enter");
  await expect(card(page, COLUMN.todo, title)).toBeVisible();

  // The menu button fades in on hover; the touch-friendly one is always there.
  await card(page, COLUMN.todo, title).hover();
  await card(page, COLUMN.todo, title)
    .getByRole("button", { name: /^(任务操作|Task actions)$/ })
    .click();
  await page.getByRole("menuitem", { name: /^(移动到|Move to)$/ }).click();
  await page.getByRole("menuitem", { name: COLUMN.doing }).click();

  await expect(card(page, COLUMN.doing, title)).toBeVisible();
  await expect(card(page, COLUMN.todo, title)).toHaveCount(0);

  await page.reload();
  await expect(card(page, COLUMN.doing, title)).toBeVisible();
});
