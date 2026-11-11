import { expect, type Page, test } from "@playwright/test";
import { searchTimeline, startWithCleanClientState } from "./workspace-helpers";

// The diary search's task hits (fork-owned, docs/fork-customizations.md section
// 12): a task is found by a word in one of its comments, the box shows the
// words around it, and the hit opens the task's panel in the cockpit. Opt-in
// like every e2e spec here (AGENTS.md). Set FORK_SHOTS to a folder to keep a
// screenshot of each step.

const SHOTS = process.env.FORK_SHOTS;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const panel = (page: Page) => page.getByRole("dialog");

test("a word from a task comment finds the task and opens it in the cockpit", async ({
  page,
}) => {
  await startWithCleanClientState(page);
  const stamp = Date.now();
  const title = `Move flat ${stamp}`;
  const word = `zebrawood${stamp}`;

  // A task with notes and two comments, one with the word.
  await page.goto("/cockpit");
  const input = page.getByRole("textbox", { name: /^(新任务|New task)$/ });
  await input.fill(title);
  await input.press("Enter");
  await page
    .getByTestId("planner-card")
    .filter({ hasText: title })
    .getByRole("button", { name: title })
    .click();
  await expect(panel(page)).toBeVisible();
  const notes = panel(page).getByRole("textbox", { name: /^(备注|Notes)$/ });
  await notes.fill("Budget and dates are in the comments.");
  await expect(panel(page).getByTestId("planner-notes-status")).toHaveText(
    /(已保存|Saved)/,
  );
  const composer = panel(page).getByRole("textbox", {
    name: /^(写评论|Write a comment)$/,
  });
  for (const text of [
    "Viewed two places, both too dark.",
    `Landlord agreed in writing; the ${word} floor flat is the one.`,
  ]) {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(
      panel(page).getByTestId("planner-comment").filter({ hasText: text }),
    ).not.toHaveAttribute("aria-busy", "true");
  }
  await shot(page, "1-task-with-comments");
  await page.keyboard.press("Escape");

  // Search the diary for the word: the Tasks box finds it in the comment.
  await page.goto("/");
  await searchTimeline(page, word);
  const box = page.getByTestId("planner-task-search");
  await expect(box).toBeVisible();
  await expect(box).toContainText(title);
  await expect(box).toContainText(/comment · \d{4}-\d{2}-\d{2}/);
  await expect(box.locator("mark").first()).toHaveText(word);
  await shot(page, "2-search-finds-comment");

  // A word from the notes finds it too.
  await searchTimeline(page, "dates are in the comments");
  await expect(box).toContainText(title);
  await expect(box).toContainText("notes");
  await shot(page, "3-search-finds-notes");

  // The hit opens the task's panel in the cockpit.
  await box.getByRole("link").filter({ hasText: title }).click();
  await expect(page).toHaveURL(/\/cockpit\?task=/);
  await expect(panel(page)).toBeVisible();
  await expect(
    panel(page).getByRole("textbox", { name: /^(任务标题|Task title)$/ }),
  ).toHaveValue(title);
  await shot(page, "4-opens-in-cockpit");
});
