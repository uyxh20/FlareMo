import { expect, type Page, test } from "@playwright/test";

// Goals and the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md). Registered in the opt-in memo-ui
// project through the regex in playwright.config.ts and, like every e2e spec
// here, written to be run only when the maintainer asks for it (AGENTS.md: e2e is
// opt-in).
//
// Both languages are matched, as the other specs do. The local test Worker has
// no model (Workers AI only runs remotely), so the review runs on the page's own
// drafts, which is the path these tests cover.

const GOALS = /^(目标|Goals)$/;
const REVIEW = /^(每周复盘|Weekly review)$/;

const heading = (page: Page, name: RegExp) =>
  page.getByRole("heading", { level: 1, name });

for (const path of ["/goals", "/weekly-review"]) {
  test(`anonymous ${path} deep link keeps its destination through sign-in`, async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto(path);
    await expect(page).toHaveURL(/\/login\?redirect=/);
    expect(new URL(page.url()).searchParams.get("redirect")).toBe(path);
  });
}

test("the Goals deep link opens the year and survives a refresh", async ({
  page,
}) => {
  await page.goto("/goals");
  await expect(heading(page, GOALS)).toBeVisible();
  await expect(page.getByTestId("planner-goals")).toBeVisible();
  // A year has 52 or 53 weeks in its heatmap.
  expect(await page.getByTestId("planner-week-cell").count()).toBeGreaterThan(
    51,
  );

  await page.reload();
  await expect(page.getByTestId("planner-goals")).toBeVisible();
});

test("a bad Goals address shows the year instead of an error", async ({
  page,
}) => {
  for (const search of ["?week=40", "?week=2026-10-06", "?year=2026&q=9"]) {
    await page.goto(`/goals${search}`);
    await expect(page.getByTestId("planner-goals")).toBeVisible();
    expect(await page.getByTestId("planner-week-cell").count()).toBeGreaterThan(
      51,
    );
  }
});

test("the sidebar links to Goals and the weekly review", async ({ page }) => {
  await page.goto("/cockpit");
  await page.getByRole("link", { name: GOALS }).first().click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByTestId("planner-goals")).toBeVisible();

  await page.getByRole("link", { name: REVIEW }).first().click();
  await expect(page).toHaveURL(/\/weekly-review/);
  await expect(heading(page, REVIEW)).toBeVisible();
});

test("the weekly review opens each part from its address", async ({ page }) => {
  await page.goto("/weekly-review?part=back");
  await expect(page.getByTestId("planner-review")).toBeVisible();
  await expect(page.getByTestId("planner-review-chat")).toBeVisible();

  await page.goto("/weekly-review?part=forward&step=2");
  await expect(page.getByTestId("planner-forward-step")).toBeVisible();
  await expect(page.getByTestId("planner-plan-slot").first()).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("planner-plan-slot").first()).toBeVisible();
});

test("Look back starts and takes a typed answer without a model", async ({
  page,
}) => {
  await page.goto("/weekly-review?part=back");
  const start = page.getByTestId("planner-start-look-back");
  // A review already started in this database picks up where it was.
  if (await start.isVisible()) await start.click();
  const composer = page.getByTestId("planner-review-composer");
  await expect(composer).toBeEnabled();
  const answer = `Typed answer ${Date.now()}`;
  await composer.fill(answer);
  await composer.press("Enter");
  await expect(
    page.getByTestId("planner-review-chat").getByText(answer),
  ).toBeVisible();
});

test("a week planned in Look forward lands on the cockpit", async ({
  page,
}) => {
  const goal = `E2E weekly goal ${Date.now()}`;
  await page.goto("/weekly-review?part=forward&step=2");
  const slot = page.getByTestId("planner-plan-slot").first();
  await expect(slot).toBeVisible();
  await slot.getByRole("textbox").fill(goal);

  // On to Plan tasks, then Commit, with the buttons under each step.
  const next = page
    .getByTestId("planner-forward-step")
    .getByRole("button", { name: /→$/ });
  await next.click();
  await next.click();
  await expect(page.getByTestId("planner-conflict-check")).toBeVisible();
  await page.getByTestId("planner-save-week").click();

  await expect(page).toHaveURL(/\/cockpit$/);
  await expect(
    page.getByTestId("planner-goal-card").filter({ hasText: goal }),
  ).toBeVisible();
});
