import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// Talk in the weekly review (fork-owned add-on, docs/fork-review-voice.md).
// Registered in the opt-in memo-ui project through the regex in
// playwright.config.ts; like every e2e spec here it runs only when asked.
//
// The browser gets a fake microphone that plays a recorded clip (a quiet
// second, then "speech", then quiet, looped). Pauses never end a turn; the
// send bubble does. Workers AI cannot run in the local Worker, so the two voice
// calls are answered here: what was "heard" and a short clip for the coach.
// The real models are checked on the dev Worker.

const MIC = resolve("tests/e2e/fixtures/review-voice-mic.wav");
const COACH = readFileSync(
  resolve("tests/e2e/fixtures/review-voice-coach.wav"),
);
const HEARD = "I trained three times and slept badly on Thursday.";
const SHOTS = process.env.REVIEW_VOICE_SHOTS;

test.use({
  permissions: ["microphone"],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${MIC}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function stubVoice(page: Page) {
  const spoken: string[] = [];
  await page.route("**/api/app/planner/voice", (route) =>
    route.fulfill({ json: { mode: "natural" } }),
  );
  await page.route("**/api/app/planner/voice/speak", async (route) => {
    spoken.push((route.request().postDataJSON() as { text: string }).text);
    // Long enough to see the speaking state.
    await new Promise((done) => setTimeout(done, 400));
    await route.fulfill({
      body: COACH,
      headers: { "content-type": "audio/wav", "x-review-voice": "natural" },
    });
  });
  let clips = 0;
  await page.route("**/api/app/planner/voice/transcribe", async (route) => {
    clips++;
    expect(route.request().headers()["content-type"]).toMatch(/^audio\//);
    await new Promise((done) => setTimeout(done, 300));
    await route.fulfill({ json: { text: HEARD, voice: "natural" } });
  });
  return { spoken, clips: () => clips };
}

test("Talk reads the question, listens, and sends what was heard", async ({
  page,
}) => {
  const voice = await stubVoice(page);
  await page.goto("/review?part=back");
  const chat = page.getByTestId("planner-review-chat");
  await expect(chat).toBeVisible();
  const start = page.getByTestId("planner-start-look-back");
  if (await start.isVisible()) await start.click();
  await expect(page.getByTestId("planner-review-composer")).toBeEnabled();
  await shot(page, "1-talk-button");

  await page.getByTestId("planner-review-talk").click();
  const bar = page.getByTestId("planner-review-voice");
  await expect(bar).toHaveAttribute("data-state", "speaking");
  await shot(page, "2-coach-speaking");
  expect(voice.spoken[0]?.length ?? 0).toBeGreaterThan(5);

  await expect(bar).toHaveAttribute("data-state", "listening", {
    timeout: 10_000,
  });
  // The clip has a quiet second, "speech", then four quiet seconds, looped:
  // a long pause. Listening goes on through it; only you end the turn.
  await page.waitForTimeout(7_000);
  await expect(bar).toHaveAttribute("data-state", "listening");
  expect(voice.clips()).toBe(0);
  await shot(page, "3-listening-through-a-pause");

  await page.getByTestId("planner-review-voice-done").click();
  await expect(chat.getByText(HEARD)).toBeVisible({ timeout: 15_000 });
  expect(voice.clips()).toBe(1);
  await shot(page, "4-answer-sent");

  // Type instead brings the answer box back.
  await page.getByTestId("planner-review-voice-type").click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId("planner-review-composer")).toBeVisible();
  await shot(page, "6-back-to-typing");
});

test("the mic button pauses and resumes, the send bubble ends the turn, and the next question is read out", async ({
  page,
}) => {
  const voice = await stubVoice(page);
  await page.goto("/review?part=back");
  await expect(page.getByTestId("planner-review-chat")).toBeVisible();
  const start = page.getByTestId("planner-start-look-back");
  if (await start.isVisible()) await start.click();
  await expect(page.getByTestId("planner-review-composer")).toBeEnabled();

  await page.getByTestId("planner-review-talk").click();
  const bar = page.getByTestId("planner-review-voice");
  await expect(bar).toHaveAttribute("data-state", "listening", {
    timeout: 10_000,
  });
  // The mic button pauses recording: the clock stops and the turn stays open.
  const mic = page.getByTestId("planner-review-voice-mic");
  const clock = page.getByTestId("planner-review-voice-time");
  await page.waitForTimeout(1_200);
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  await expect(bar).toContainText(/Mic paused|麦克风已暂停/);
  const held = await clock.textContent();
  await page.waitForTimeout(2_200);
  await expect(clock).toHaveText(held ?? "");
  expect(voice.clips()).toBe(0);
  await shot(page, "3b-mic-paused");
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(bar).toContainText(/Listening|正在听/);

  await page.getByTestId("planner-review-voice-done").click();
  await expect(
    page.getByTestId("planner-review-chat").getByText(HEARD).last(),
  ).toBeVisible({ timeout: 15_000 });

  // Next: the following prompt arrives and is read out while Talk stays on.
  const before = voice.spoken.length;
  await page.getByTestId("planner-review-next").click();
  await expect.poll(() => voice.spoken.length).toBeGreaterThan(before);
  await expect(bar).toHaveAttribute("data-state", "speaking");
  await shot(page, "5-next-question-read-out");
});
