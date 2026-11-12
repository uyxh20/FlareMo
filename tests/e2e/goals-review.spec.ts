import { expect, type Page, test } from "@playwright/test";

// Goals and the review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md; /review is the week plus the month,
// quarter or year closing with it, docs/planning-cockpit-period-review.md). Registered in the opt-in memo-ui
// project through the regex in playwright.config.ts and, like every e2e spec
// here, written to be run only when the maintainer asks for it (AGENTS.md: e2e is
// opt-in).
//
// Both languages are matched, as the other specs do. The local test Worker has
// no model (Workers AI only runs remotely), so the review runs on the page's own
// drafts, which is the path these tests cover.

const GOALS = /^(目标|Goals)$/;
const REVIEW = /^(复盘|Review)$/;
// The sidebar link's name carries "due" from Saturday to Monday.
const REVIEW_LINK = /^(复盘|Review)( due|待完成)?$/;

const heading = (page: Page, name: RegExp) =>
  page.getByRole("heading", { level: 1, name });

for (const path of ["/goals", "/review"]) {
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
  // The timeline (the default view) has a chip for each of the year's 52 or
  // 53 weeks.
  await expect(page.getByTestId("planner-goals-timeline")).toBeVisible();
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
    await expect(page.getByTestId("planner-goals-timeline")).toBeVisible();
    expect(await page.getByTestId("planner-week-cell").count()).toBeGreaterThan(
      51,
    );
  }
});

test("the Year map follows one pillar and opens a month's weeks", async ({
  page,
}) => {
  await page.goto("/goals?year=2026");
  // The grid is the second view: the switch brings it up.
  await page.getByTestId("planner-goals-view-grid").click();
  const map = page.getByTestId("planner-year-map");
  await expect(map).toBeVisible();
  const work = page.getByRole("button", { name: /^(Work|工作)$/ });
  await work.click();
  await expect(work).toHaveAttribute("aria-pressed", "true");
  await expect(map).toHaveClass(/is-following/);

  const january = page.getByRole("button", { name: /January|一月/ });
  await expect(january).toHaveAttribute("aria-expanded", "false");
  await january.click();
  await expect(january).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("link", { name: /Week 1$|第 1 周/ }),
  ).toBeVisible();
});

test("Goals opens on the timeline; the switch shows the grid and is remembered", async ({
  page,
}) => {
  await page.goto("/goals?year=2026");
  const timeline = page.getByTestId("planner-goals-timeline");
  const grid = page.getByTestId("planner-year-map");
  await expect(timeline).toBeVisible();
  await expect(grid).toHaveCount(0);
  await expect(page.getByTestId("planner-goals-view-timeline")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Following one pillar leaves its row only.
  const work = page.getByRole("button", { name: /^(Work|工作)$/ });
  await work.click();
  await expect(timeline).toHaveClass(/is-following/);

  await page.getByTestId("planner-goals-view-grid").click();
  await expect(grid).toBeVisible();
  await expect(timeline).toHaveCount(0);

  // The choice is kept on this device.
  await page.reload();
  await expect(grid).toBeVisible();
  await page.getByTestId("planner-goals-view-timeline").click();
  await expect(timeline).toBeVisible();
  await page.reload();
  await expect(timeline).toBeVisible();
});

test("the sidebar links to Goals and the review", async ({ page }) => {
  await page.goto("/cockpit");
  await page.getByRole("link", { name: GOALS }).first().click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByTestId("planner-goals")).toBeVisible();

  await page.getByRole("link", { name: REVIEW_LINK }).first().click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(heading(page, REVIEW)).toBeVisible();
});

test("the old review addresses go to /review and keep their part", async ({
  page,
}) => {
  await page.goto("/review?part=forward&step=2");
  await expect(page).toHaveURL(/\/review\?part=forward&step=2$/);
  await expect(page.getByTestId("planner-forward-step")).toBeVisible();

  await page.goto("/period-review?level=month");
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByTestId("planner-review")).toBeVisible();
});

test("the chapters run in order: the ones ahead are not links", async ({
  page,
}) => {
  await page.goto("/review?part=back");
  await expect(page.getByTestId("planner-review-chapter-back")).toBeVisible();
  // Look forward is a chapter, but Look back is still open, so it waits.
  const forward = page.getByTestId("planner-review-chapter-forward");
  await expect(forward).toBeVisible();
  const linked = (await forward.getAttribute("href")) !== null;
  const backDone = await page
    .getByTestId("planner-review-chapter-back")
    .getByText(/Done|完成/)
    .isVisible();
  expect(linked).toBe(backDone);
});

test("the review opens each chapter from its address", async ({ page }) => {
  await page.goto("/review?part=back");
  await expect(page.getByTestId("planner-review")).toBeVisible();
  await expect(page.getByTestId("planner-review-chat")).toBeVisible();

  await page.goto("/review?part=forward&step=2");
  await expect(page.getByTestId("planner-forward-step")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "+ Add a goal" }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("button", { name: "+ Add a goal" }),
  ).toBeVisible();
});

test("Look back starts and takes a typed answer without a model", async ({
  page,
}) => {
  await page.goto("/review?part=back");
  // isVisible() does not wait: let the chat render before asking whether the
  // review still needs starting, or a fresh review is never started.
  await expect(page.getByTestId("planner-review-chat")).toBeVisible();
  const start = page.getByTestId("planner-start-look-back");
  // Before it starts, the chat says what it reads: entries, health rows,
  // tasks done and goals, counted (the audit block, as in a period chapter).
  if (await start.isVisible()) {
    await expect(page.getByTestId("planner-review-reads")).toBeVisible();
  }
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

test("Start over clears the review and opens a fresh Look back", async ({
  page,
}) => {
  await page.goto("/review?part=back");
  // isVisible() does not wait: let the chat render before asking whether the
  // review still needs starting, or a fresh review is never started.
  await expect(page.getByTestId("planner-review-chat")).toBeVisible();
  const start = page.getByTestId("planner-start-look-back");
  if (await start.isVisible()) await start.click();
  const composer = page.getByTestId("planner-review-composer");
  await expect(composer).toBeEnabled();
  const answer = `Answer to clear ${Date.now()}`;
  await composer.fill(answer);
  await composer.press("Enter");
  const chat = page.getByTestId("planner-review-chat");
  await expect(chat.getByText(answer)).toBeVisible();

  await page.getByTestId("planner-review-start-over").click();
  await page.getByTestId("planner-review-start-over-confirm").click();
  await expect(page.getByTestId("planner-start-look-back")).toBeVisible();
  await expect(page.getByText(answer)).toHaveCount(0);
  // The server holds the cleared review too.
  await page.reload();
  await expect(page.getByTestId("planner-start-look-back")).toBeVisible();
  await expect(page.getByText(answer)).toHaveCount(0);
});

test("a week planned in Look forward lands on the cockpit", async ({
  page,
}) => {
  const goal = `E2E weekly goal ${Date.now()}`;
  await page.goto("/review?part=forward&step=2");
  await page.getByRole("button", { name: "+ Add a goal" }).click();
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

test("Choose the week: a proposed goal is edited, then Add makes it a goal of the week", async ({
  page,
}) => {
  const proposal = (id: string, pillar: string, title: string) => ({
    id,
    kind: "goal",
    week_start: "2026-11-02",
    pillar,
    title,
    lines: [],
    goal_ref: null,
    serves: null,
    why: "Because it came up this week.",
    quote: null,
    source_day: null,
    state: "open",
  });
  // The page asks the agent only when one is set up: turn that on in the
  // review's own response.
  await page.route("**/api/**", async (route) => {
    if (
      route.request().method() !== "GET" ||
      /proposals/.test(route.request().url())
    ) {
      return route.fallback();
    }
    const response = await route.fetch();
    const type = response.headers()["content-type"] ?? "";
    if (!type.includes("json")) return route.fulfill({ response });
    const body = await response.json();
    if (body && "plan_goals" in body && typeof body.ai === "boolean") {
      body.ai = true;
    }
    return route.fulfill({ response, json: body });
  });
  await page.route("**/proposals?*", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            proposals: [
              proposal("p-work", "work", "Sign the DocuSign"),
              proposal("p-health", "health", "Run three times"),
            ],
            pending: false,
            agent: true,
            drafting: null,
          },
        })
      : route.fallback(),
  );
  await page.goto("/review?part=forward&step=2");
  const cards = page.getByTestId("planner-proposal");
  await expect(cards).toHaveCount(2);
  // No pre-filled goal cards under the proposals: only goals saved for the
  // week before (an earlier test may have saved one) show, each with text.
  const slots = page.getByTestId("planner-plan-slot");
  const before = await slots.count();
  for (const box of await slots.getByRole("textbox").all()) {
    await expect(box).not.toHaveValue("");
  }

  await page.setViewportSize({ width: 1100, height: 900 });
  const first = cards.first();
  await first.getByTestId("planner-proposal-title").fill("Sign the contract");
  await first.getByRole("button", { name: "Objective" }).click();
  await first.getByRole("button", { name: "Add", exact: true }).click();

  await expect(slots).toHaveCount(before + 1);
  const added = slots.filter({
    has: page.locator("textarea", { hasText: "Sign the contract" }),
  });
  await expect(added).toHaveCount(1);
  // It lands under the objective picked, not the proposal's own.
  await expect(
    added.getByRole("button", { name: "Objective", pressed: true }),
  ).toBeVisible();
  await expect(cards).toHaveCount(1);

  // Clearing the added goal's text does not make its card vanish mid-edit.
  await added.getByRole("textbox").fill("");
  await expect(slots).toHaveCount(before + 1);

  // "+ Add a goal" shows one more empty goal to write.
  await page.getByRole("button", { name: "+ Add a goal" }).click();
  await expect(slots).toHaveCount(before + 2);
});
