import { expect, type Page, test } from "@playwright/test";
import { E2E_BASE_URL } from "./auth-fixture";
import { startWithCleanClientState } from "./workspace-helpers";

// The fork's small UI changes (docs/fork-customizations.md): three sidebar
// entries hidden, and the "#" tag picker in the memo composer made scrollable
// and keyboard-driven. Registered in the opt-in memo-ui project through the
// regex in playwright.config.ts and, like every e2e spec here, written to be run
// only when the maintainer asks for it (AGENTS.md: e2e is opt-in).
//
// Both languages are matched everywhere, as the other specs do.

const E2E_COOKIE_MUTATION_OPTIONS = {
  headers: { origin: E2E_BASE_URL },
};

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

// --- The "#" tag picker -------------------------------------------------------

// Tags and how many notes carry each. More than eight, so the list has to
// scroll, and three that start with "car" so the order of a typed name is known:
// carlsberg is the most used of them.
const TAGGED_NOTES: Array<[tag: string, notes: number]> = [
  ["bender", 5],
  ["carlsberg", 4],
  ["gym", 3],
  ["carbon", 2],
  ["mindshare", 2],
  ["wimhof", 2],
  ["cargo", 1],
  ["forkui-a", 1],
  ["forkui-b", 1],
  ["forkui-c", 1],
  ["forkui-d", 1],
  ["forkui-e", 1],
];

let tagsSeeded = false;

async function seedTags(page: Page) {
  if (tagsSeeded) return;
  for (const [tag, notes] of TAGGED_NOTES) {
    for (let index = 0; index < notes; index += 1) {
      const response = await page.request.post("/api/app/memos", {
        ...E2E_COOKIE_MUTATION_OPTIONS,
        data: { content: `Fork UI tag note ${index} #${tag}` },
      });
      expect(response.ok()).toBe(true);
    }
  }
  tagsSeeded = true;
}

/** The timeline composer, focused and ready for typing, on a clean draft. */
async function openComposer(page: Page) {
  await seedTags(page);
  await startWithCleanClientState(page);
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: /new note|新笔记/i });
  await expect(composer).toBeVisible();
  await composer.click();
  return composer;
}

const tagList = (page: Page) =>
  page.getByRole("listbox", { name: /^(Tags|标签)$/ });

test("# lists every tag in a scrollable list under the composer", async ({
  page,
}) => {
  const composer = await openComposer(page);
  await composer.pressSequentially("#");

  const list = tagList(page);
  await expect(list).toBeVisible();
  // The picker used to stop at six; every tag is there now.
  await expect
    .poll(() => list.getByRole("option").count())
    .toBeGreaterThanOrEqual(TAGGED_NOTES.length);
  // Nothing is highlighted yet, so Enter stays a plain new line.
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);

  // It scrolls inside itself, and shows about eight rows.
  await expect
    .poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true);
  const box = await list.boundingBox();
  const form = await composer.locator("xpath=ancestor::form").boundingBox();
  const header = await page.locator("header").first().boundingBox();
  if (!box || !form || !header) throw new Error("no layout to measure");
  expect(box.height).toBeLessThanOrEqual(288);

  // It hangs below the composer, over the notes, and below the page header.
  expect(box.y).toBeGreaterThanOrEqual(form.y + form.height);
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(box.y + box.height).toBeLessThanOrEqual(
    page.viewportSize()?.height ?? Number.POSITIVE_INFINITY,
  );

  // The editor keeps the caret while the list scrolls.
  await list.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(composer).toBeFocused();
});

test("typing a name highlights the best match and Tab completes it", async ({
  page,
}) => {
  const composer = await openComposer(page);
  await composer.pressSequentially("#car");

  const list = tagList(page);
  const first = list.getByRole("option").first();
  await expect(first).toContainText("carlsberg");
  await expect(first).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Tab");
  await expect(list).toBeHidden();
  await expect(composer).toContainText("#carlsberg");
  // The tag and a trailing space, as when a row is clicked.
  expect(await composer.evaluate((el) => el.textContent)).toMatch(
    /^#carlsberg\s$/,
  );
  await expect(composer).toBeFocused();
});

test("arrows move the highlight and Escape closes the list", async ({
  page,
}) => {
  const composer = await openComposer(page);
  await composer.pressSequentially("#car");

  const list = tagList(page);
  const options = list.getByRole("option");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(composer).toContainText("#car");
  await expect(composer).toBeFocused();

  // Typing on brings the list back.
  await composer.pressSequentially("l");
  await expect(list).toBeVisible();
});

test("Escape in the focus canvas closes only the open tag list", async ({
  page,
}) => {
  await openComposer(page);
  await page.getByRole("button", { name: /^(Full screen|全屏)$/ }).click();
  const canvas = page.locator('[data-slot="composer-canvas-popup"]');
  await expect(canvas).toBeVisible();

  // The canvas editor takes the focus by itself. (Text first: a lone "#" as the
  // first character of an empty canvas is wiped by the timeline composer's own
  // draft sync, which is how upstream behaves.)
  await page.keyboard.type("note #car");
  const list = tagList(page);
  await expect(list).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(canvas).toBeVisible();

  // With no list open, Escape closes the canvas as it always did.
  await page.keyboard.press("Escape");
  await expect(canvas).toBeHidden();
});
