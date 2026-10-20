import { expect, type Page, test } from "@playwright/test";

// Ask my diary's chat bubble and Look forward's goal suggestions
// (docs/fork-general-agent.md). The general agent is not set up in the e2e
// stack, so its answers are stubbed at the network: these check the page, not
// the agent. Opt-in like every e2e spec here (AGENTS.md).

const ASK_IDLE = {
  enabled: true,
  conversation: null,
  messages: [],
  status: "idle",
};

async function stubAsk(page: Page) {
  await page.route("**/api/app/planner/ask?*", (route) =>
    route.fulfill({ json: ASK_IDLE }),
  );
}

test("Ask my diary is a bubble in the bottom-right corner of every page", async ({
  page,
}) => {
  await stubAsk(page);
  for (const path of ["/", "/cockpit", "/goals"]) {
    await page.goto(path);
    const bubble = page.getByTestId("planner-ask-button");
    await expect(bubble).toBeVisible();
    const box = await bubble.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport).toBeTruthy();
    if (!box || !viewport) return;
    expect(viewport.width - (box.x + box.width)).toBeLessThan(40);
    expect(viewport.height - (box.y + box.height)).toBeLessThan(40);
  }
  // Not in the sidebar any more.
  const nav = page.getByRole("navigation", { name: /^(Navigation|导航)$/ });
  await expect(nav.getByText(/^(Ask my diary|问日记)$/)).toHaveCount(0);

  await page.getByTestId("planner-ask-button").click();
  const window = page.getByTestId("planner-ask-window");
  await expect(window).toBeVisible();
  const chat = await window.boundingBox();
  const bubble = await page.getByTestId("planner-ask-button").boundingBox();
  // The window opens just above the bubble, which stays to close it.
  expect(chat && bubble && chat.y + chat.height <= bubble.y).toBeTruthy();
  await page.getByTestId("planner-ask-button").click();
  await expect(window).toHaveCount(0);
});

test("Look forward asks the agent for goals once and shows them first", async ({
  page,
}) => {
  await stubAsk(page);
  // The review as if the look back were done with a summary and the agent set up.
  await page.route("**/api/app/planner/review?*", async (route) => {
    const response = await route.fetch();
    const review = await response.json();
    await route.fulfill({
      response,
      json: {
        ...review,
        ai: true,
        summary: { id: "summary", content: "# Week\n" },
      },
    });
  });
  let asked = 0;
  const proposal = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "goal",
    pillar: "work",
    title: "Ship the proposal to the client",
    why: "It came up three times in the look back.",
    quote: null,
    source_day: null,
    goal_ref: null,
    serves: {
      level: "month",
      period_start: "2026-10-01",
      title: "Sign the client",
    },
    state: "open",
  };
  await page.route("**/review/*/proposals*", async (route) => {
    if (route.request().method() === "POST") {
      asked += 1;
      await route.fulfill({
        json: { proposals: [], pending: true, agent: true, drafting: "goals" },
      });
      return;
    }
    await route.fulfill({
      json:
        asked === 0
          ? { proposals: [], pending: false, agent: true, drafting: null }
          : {
              proposals: [proposal],
              pending: false,
              agent: true,
              drafting: null,
            },
    });
  });

  await page.goto("/review?part=forward&step=2");
  const section = page.getByTestId("planner-goal-proposals");
  await expect(section).toBeVisible();
  await expect(section.getByText(proposal.title)).toBeVisible({
    timeout: 15_000,
  });
  expect(asked).toBe(1);
  // Each suggested goal names the month or quarter goal it moves.
  await expect(section.getByTestId("planner-proposal-serves")).toContainText(
    "Sign the client",
  );
  // The suggestions come before the goal slots.
  const slots = page.getByTestId("planner-forward-step").locator("textarea");
  const sectionBox = await section.boundingBox();
  const slotBox = await slots.first().boundingBox();
  expect(sectionBox && slotBox && sectionBox.y < slotBox.y).toBeTruthy();

  // Suggest again asks anew.
  await section.getByTestId("planner-suggest-goals").click();
  await expect.poll(() => asked).toBe(2);
});
