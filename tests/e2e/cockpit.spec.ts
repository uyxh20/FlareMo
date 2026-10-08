import { expect, type Page, test } from "@playwright/test";
import { startWithCleanClientState } from "./workspace-helpers";

// The planning cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 5, 6 and 13). Registered
// in the opt-in memo-ui project through the regex in playwright.config.ts, and,
// like every e2e spec here, written to be run only when the maintainer asks for it
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

test("quick add puts a task in Backlog, and there are no period chips", async ({
  page,
}) => {
  await startWithCleanClientState(page);
  const title = `Cockpit quick add ${Date.now()}`;

  await page.goto("/cockpit");
  const input = page.getByRole("textbox", { name: /^(新任务|New task)$/ });
  await expect(input).toBeVisible();
  // v1.2 dropped the period chips (All, Today, This week, This month).
  await expect(
    page.getByRole("button", { name: /^(本周|This week)$/ }),
  ).toHaveCount(0);
  await input.fill(title);
  await input.press("Enter");

  await expect(card(page, COLUMN.backlog, title)).toBeVisible();
  // The field empties so the next task can be typed straight away.
  await expect(input).toHaveValue("");

  // It is on the server, not only on the screen.
  await page.reload();
  await expect(card(page, COLUMN.backlog, title)).toBeVisible();
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

// ---------------------------------------------------------------------------
// v1.1: the column "+" and the task panel (plan section 13)
//
// While the panel is open its sheet is modal, so the board behind it is hidden
// from the accessibility tree and `getByRole` cannot see it: the tests close the
// panel (Escape) before they look at the board again.

const ADD_BUTTON = {
  backlog: /^(添加到待规划|Add to Backlog)$/,
  todo: /^(添加到待办|Add to To Do)$/,
  doing: /^(添加到进行中|Add to Doing)$/,
  done: /^(添加到已完成|Add to Done)$/,
};

const COMPOSER = {
  backlog: /^(在待规划中新建任务|New task in Backlog)$/,
  todo: /^(在待办中新建任务|New task in To Do)$/,
  doing: /^(在进行中中新建任务|New task in Doing)$/,
  done: /^(在已完成中新建任务|New task in Done)$/,
};

const panel = (page: Page) => page.getByRole("dialog");
const titleField = (page: Page) =>
  panel(page).getByRole("textbox", { name: /^(任务标题|Task title)$/ });

/** Adds a task straight into To Do with that column's "+", the way most cases need a card. */
async function quickAdd(page: Page, title: string) {
  await page.goto("/cockpit");
  await page.getByRole("button", { name: ADD_BUTTON.todo }).click();
  const input = page.getByRole("textbox", { name: COMPOSER.todo });
  await input.fill(title);
  await input.press("Enter");
  await expect(card(page, COLUMN.todo, title)).toBeVisible();
  await input.press("Escape");
}

/** Opens a card's panel by clicking its title, and waits for the task to load. */
async function openPanel(page: Page, column_: RegExp, title: string) {
  await card(page, column_, title).getByRole("button", { name: title }).click();
  await expect(panel(page)).toBeVisible();
  await expect(titleField(page)).toHaveValue(title);
}

/** The address of the open panel: /cockpit?task=<id>. */
async function panelAddress(page: Page) {
  await expect(page).toHaveURL(/\/cockpit\?task=[^&]+$/);
  return page.url();
}

async function closePanelWithEscape(page: Page) {
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/cockpit$/);
}

test("a column's + adds a task straight into that column", async ({ page }) => {
  await startWithCleanClientState(page);
  const stamp = Date.now();
  await page.goto("/cockpit");

  // Backlog, Doing and Done take the task as it is typed.
  for (const [key, label] of [
    ["backlog", COLUMN.backlog],
    ["doing", COLUMN.doing],
    ["done", COLUMN.done],
  ] as const) {
    const title = `Cockpit plus ${key} ${stamp}`;
    await page.getByRole("button", { name: ADD_BUTTON[key] }).click();
    const input = page.getByRole("textbox", { name: COMPOSER[key] });
    await expect(input).toBeFocused();
    await input.fill(title);
    await input.press("Enter");
    await expect(card(page, label, title)).toBeVisible();
    // The composer stays open and empty for the next task...
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    // ...until Escape.
    await input.press("Escape");
    await expect(input).toHaveCount(0);
  }

  // To Do takes the task with its marker plan (today), which nothing shows.
  const planned = `Cockpit plus todo ${stamp}`;
  await page.getByRole("button", { name: ADD_BUTTON.todo }).click();
  const input = page.getByRole("textbox", { name: COMPOSER.todo });
  await input.fill(planned);
  await input.press("Enter");
  await expect(card(page, COLUMN.todo, planned)).toBeVisible();
  await input.press("Escape");

  // All of them are on the server, in the column they were added to.
  await page.reload();
  await expect(
    card(page, COLUMN.backlog, `Cockpit plus backlog ${stamp}`),
  ).toBeVisible();
  await expect(
    card(page, COLUMN.doing, `Cockpit plus doing ${stamp}`),
  ).toBeVisible();
  await expect(
    card(page, COLUMN.done, `Cockpit plus done ${stamp}`),
  ).toBeVisible();
  await expect(card(page, COLUMN.todo, planned)).toBeVisible();
});

test("a column's + closes when left empty and keeps what is typed", async ({
  page,
}) => {
  await page.goto("/cockpit");
  await page.getByRole("button", { name: ADD_BUTTON.doing }).click();
  const input = page.getByRole("textbox", { name: COMPOSER.doing });
  await expect(input).toBeVisible();

  // Leaving it empty closes it.
  await page
    .getByRole("heading", { level: 1, name: /^(驾驶舱|Cockpit)$/ })
    .click();
  await expect(input).toHaveCount(0);

  // Leaving it with text keeps the text, so nothing typed is lost.
  await page.getByRole("button", { name: ADD_BUTTON.doing }).click();
  await input.fill("half typed");
  await page
    .getByRole("heading", { level: 1, name: /^(驾驶舱|Cockpit)$/ })
    .click();
  await expect(input).toHaveValue("half typed");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
});

test("clicking a card opens its panel, the address names the task, and Escape closes it", async ({
  page,
}) => {
  const title = `Cockpit panel ${Date.now()}`;
  await quickAdd(page, title);

  await openPanel(page, COLUMN.todo, title);
  await panelAddress(page);

  await closePanelWithEscape(page);
  // The card is still on the board, and the title button has the focus back.
  await expect(card(page, COLUMN.todo, title)).toBeVisible();
  await expect(
    card(page, COLUMN.todo, title).getByRole("button", { name: title }),
  ).toBeFocused();
});

test("a click on a card's own padding opens its panel too, but the status icon and the menu keep their own jobs", async ({
  page,
}) => {
  const title = `Cockpit chip ${Date.now()}`;
  await quickAdd(page, title);

  // The ⋯ menu opens a menu, not the panel.
  await card(page, COLUMN.todo, title).hover();
  await card(page, COLUMN.todo, title)
    .getByRole("button", { name: /^(任务操作|Task actions)$/ })
    .click();
  await expect(
    page.getByRole("menuitem", { name: /^(历史记录|History)$/ }),
  ).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The card's padding is part of the card: a click there opens it.
  await card(page, COLUMN.todo, title).click({ position: { x: 4, y: 4 } });
  await expect(panel(page)).toBeVisible();
  await expect(titleField(page)).toHaveValue(title);
});

test("the panel opens from its link, the back button closes it, and closing a linked panel stays on the page", async ({
  page,
}) => {
  const title = `Cockpit link ${Date.now()}`;
  await quickAdd(page, title);

  await openPanel(page, COLUMN.todo, title);
  const link = await panelAddress(page);

  // Back closes the panel it opened.
  await page.goBack();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/cockpit$/);

  // The link opens it on load, with the task read from the server.
  await page.goto("/");
  await page.goto(link);
  await expect(panel(page)).toBeVisible();
  await expect(titleField(page)).toHaveValue(title);

  // Closing it rewrites the address instead of walking back off the page.
  await panel(page)
    .getByRole("button", { name: /^(关闭|Close)$/ })
    .click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/cockpit$/);
  await expect(card(page, COLUMN.todo, title)).toBeVisible();
});

test("a link to a task that does not exist says so", async ({ page }) => {
  await page.goto("/cockpit?task=00000000-0000-0000-0000-000000000000");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText(
    /(这项任务已不存在|This task isn't available any more)/,
  );
});

test("a task's notes save by themselves and are there after a reload", async ({
  page,
}) => {
  const title = `Cockpit notes ${Date.now()}`;
  const notes = `Notes typed in the panel ${Date.now()}`;
  await quickAdd(page, title);
  await openPanel(page, COLUMN.todo, title);
  const link = await panelAddress(page);

  const box = panel(page).getByRole("textbox", { name: /^(备注|Notes)$/ });
  await box.fill(notes);
  // No Save button: the box says so when it has saved, about a second later.
  await expect(panel(page).getByTestId("planner-notes-status")).toHaveText(
    /(已保存|Saved)/,
  );

  await page.goto("/");
  await page.goto(link);
  await expect(
    panel(page).getByRole("textbox", { name: /^(备注|Notes)$/ }),
  ).toHaveValue(notes);
});

test("a comment is sent with Enter, is there after a reload, and is deleted after a confirmation", async ({
  page,
}) => {
  const title = `Cockpit comments ${Date.now()}`;
  const text = `A comment ${Date.now()}`;
  await quickAdd(page, title);
  await openPanel(page, COLUMN.todo, title);
  const link = await panelAddress(page);

  await expect(panel(page)).toContainText(/(还没有评论。|No comments yet\.)/);
  const composer = panel(page).getByRole("textbox", {
    name: /^(写评论|Write a comment)$/,
  });
  await composer.fill(text);
  await composer.press("Enter");
  // It empties the box at once and shows the comment, dimmed until it is saved.
  await expect(composer).toHaveValue("");
  const comment = panel(page)
    .getByTestId("planner-comment")
    .filter({ hasText: text });
  await expect(comment).toBeVisible();
  await expect(comment).toContainText(/(你|You)/);
  await expect(comment).not.toHaveAttribute("aria-busy", "true");

  await page.goto("/");
  await page.goto(link);
  await expect(
    panel(page).getByTestId("planner-comment").filter({ hasText: text }),
  ).toBeVisible();

  // Delete asks first.
  await panel(page)
    .getByRole("button", { name: /^(删除评论|Delete comment)$/ })
    .click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /^(删除|Delete)$/ }).click();
  await expect(panel(page).getByTestId("planner-comment")).toHaveCount(0);
  await expect(panel(page)).toContainText(/(还没有评论。|No comments yet\.)/);
});

test("the panel's properties save and the card follows", async ({ page }) => {
  const title = `Cockpit properties ${Date.now()}`;
  await quickAdd(page, title);
  await openPanel(page, COLUMN.todo, title);
  const link = await panelAddress(page);

  // Priority: a menu, saved the moment it is picked.
  await panel(page)
    .getByRole("button", { name: /^(优先级|Priority): / })
    .click();
  await page.getByRole("menuitem", { name: /(高|High)/ }).click();
  await expect(
    panel(page).getByRole("button", { name: /^(优先级|Priority): (高|High)$/ }),
  ).toBeVisible();

  // Effort: typed, saved on Enter.
  const effort = panel(page).getByRole("textbox", {
    name: /^(工作量|Effort)$/,
  });
  await effort.fill("3.5");
  await effort.press("Enter");

  // An effort that is not a number says so and saves nothing.
  await effort.fill("3.25");
  await expect(panel(page).getByRole("alert")).toBeVisible();
  await effort.press("Escape");
  await expect(effort).toHaveValue("3.5");
  // Escape left the field, not the panel.
  await expect(panel(page)).toBeVisible();

  // Status: moving the task from the panel moves its card.
  await panel(page)
    .getByRole("button", { name: /^(状态|Status): / })
    .click();
  await page.getByRole("menuitem", { name: COLUMN.doing }).click();
  await expect(
    panel(page).getByRole("button", {
      name: /^(状态|Status): (进行中|Doing)$/,
    }),
  ).toBeVisible();

  // Everything is on the server.
  await page.goto("/");
  await page.goto(link);
  await expect(
    panel(page).getByRole("button", { name: /^(优先级|Priority): (高|High)$/ }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole("textbox", { name: /^(工作量|Effort)$/ }),
  ).toHaveValue("3.5");
  await expect(
    panel(page).getByRole("button", {
      name: /^(状态|Status): (进行中|Doing)$/,
    }),
  ).toBeVisible();

  // And the board behind the panel has the card in Doing.
  await closePanelWithEscape(page);
  await expect(card(page, COLUMN.doing, title)).toBeVisible();
  await expect(card(page, COLUMN.todo, title)).toHaveCount(0);
});

test("dragging a card moves it and does not open its panel", async ({
  page,
}) => {
  const title = `Cockpit drag ${Date.now()}`;
  await quickAdd(page, title);

  // The mouse works in viewport coordinates: bring the card into view first, then
  // read where both ends are.
  await card(page, COLUMN.todo, title).scrollIntoViewIfNeeded();
  const source = await card(page, COLUMN.todo, title).boundingBox();
  const target = await column(page, COLUMN.doing).boundingBox();
  if (!source || !target) throw new Error("The board is not laid out.");
  // Columns grow with their cards, so aim at the part of Doing that is on screen.
  const viewportHeight = page.viewportSize()?.height ?? 720;
  const visibleTop = Math.max(target.y, 0);
  const visibleBottom = Math.min(target.y + target.height, viewportHeight);
  const dropY = visibleTop + Math.min((visibleBottom - visibleTop) / 2, 200);

  // A press, a move past the sensor's distance, a long move to the other column,
  // and a release: the click that ends a drag must not open the card.
  await page.mouse.move(source.x + 60, source.y + 20);
  await page.mouse.down();
  await page.mouse.move(source.x + 70, source.y + 30, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, dropY, { steps: 12 });
  await page.mouse.up();

  await expect(card(page, COLUMN.doing, title)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/cockpit$/);
});

test("a start date and a due date read as one range on the card, and the panel shows when the task was created", async ({
  page,
}) => {
  const title = `Cockpit range ${Date.now()}`;
  await quickAdd(page, title);

  await openPanel(page, COLUMN.todo, title);
  const link = await panelAddress(page);

  // Created is read-only: the day the task was made.
  await expect(panel(page).getByText(/^(创建|Created)$/)).toBeVisible();

  // Start date: a date field, saved once a whole day is typed.
  await panel(page)
    .getByRole("button", { name: /^(开始日期|Start date): / })
    .click();
  await panel(page)
    .getByRole("textbox", { name: /^(开始日期|Start date)$/ })
    .fill("2026-10-08");
  await expect(
    panel(page).getByRole("button", { name: /^(开始日期|Start date): .*8/ }),
  ).toBeVisible();

  // Due date, the same way.
  await panel(page)
    .getByRole("button", { name: /^(截止日期|Due date): / })
    .click();
  await panel(page)
    .getByRole("textbox", { name: /^(截止日期|Due date)$/ })
    .fill("2026-10-12");
  await expect(
    panel(page).getByRole("button", { name: /^(截止日期|Due date): .*12/ }),
  ).toBeVisible();

  // Both dates on the card: one range.
  await closePanelWithEscape(page);
  await expect(card(page, COLUMN.todo, title).getByText(/→/)).toBeVisible();

  // Everything is on the server.
  await page.reload();
  await expect(card(page, COLUMN.todo, title).getByText(/→/)).toBeVisible();
  await page.goto(link);
  await expect(
    panel(page).getByRole("button", { name: /^(开始日期|Start date): .*8/ }),
  ).toBeVisible();
});
