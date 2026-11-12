# Talk: the weekly review by voice

Fork add-on, built 11 Nov 2026 (thread "Build the voice review"). A **Talk**
button beside Send in Look back's answer box turns the box into a voice bar.
The coach's newest message is read out, then the microphone listens, and what
you said goes in as an ordinary typed answer. Claude (or whichever model runs
the review) stays the brain: voice only fills the answer box and reads replies
aloud. Nothing is recorded or kept.

## The loop

1. Tap **Talk** (it shows once Look back has started). The browser asks for the
   microphone the first time.
2. **Coach is speaking**: the newest coach message or question is read out.
   **Skip** stops it and goes straight to listening.
3. **Listening**: speak, and pause as long as you like. Pauses never end your
   turn (Anon's call on 12 Nov 2026, after the first version cut people off
   mid-thought): you end it by tapping the **Send** bubble, as in the
   tap-to-send mode of the big voice assistants. The bar shows how long you
   have been talking. Only at 6 minutes is the answer sent without a tap.
4. **Writing down what you said**, then **Thinking**: the words appear in the
   chat as your answer and the coach replies as usual. Its reply is read out,
   and the loop goes on. Messages that arrive together (a reply and the next
   question) are read as one.
5. Where the review wants a tap rather than words (scores, goal results,
   options), the bar says so and waits; tapping Next or an option carries on.
6. **Type instead** turns voice off and brings the answer box back at any time.

What is read: coach replies, the recap, last week's question, each prompt, the
trajectory and the question for next Sunday, the verdict title. Your answers
and the cards (scores, goals) are not.

## Where it runs

All on Workers AI through the Worker's existing `AI` binding, so no audio
leaves Cloudflare and no new account or key is needed.

| `FLAREMO_REVIEW_VOICE`     | Listening                           | Speaking                                      |
| -------------------------- | ----------------------------------- | --------------------------------------------- |
| `natural` (default, unset) | `@cf/deepgram/nova-3`               | `@cf/deepgram/aura-2-en`, speaker `luna`, mp3 |
| `basic`                    | `@cf/openai/whisper-large-v3-turbo` | `@cf/myshell-ai/melotts`                      |
| `off`                      | no Talk button                      |                                               |

If a natural model call fails (for example the free plan's daily allowance is
used up), that one call is retried on the basic model, and the Worker logs it.

Checked on the dev Worker on 11 Nov 2026 on the **free** plan: the natural
voice spoke a question as mp3 and nova-3 heard it back word for word from mp3,
WebM/Opus (Chrome, Android) and MP4/AAC (iPhone Safari) clips. So the Workers
Paid plan is not needed to use it. Workers AI's free allowance is 10,000
neurons a day, shared with search and the other AI calls; a weekly review uses
a small part of it (see the cost note in the project thread "Brainstorm what to
build next"). Going beyond it needs Workers Paid ($5 a month): Cloudflare
dashboard, Workers & Pages, Plans.

## Routes

`apps/worker/src/routes/planner-voice-api.ts`, mounted inside the planner API
(so the planner's lazy mount, sign-in and JSON 404 apply). Each POST is
rate-limited with the planner's limit.

| Route                                    | Takes                                                               | Answers                                                 |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/app/planner/voice`             |                                                                     | `{ mode }`                                              |
| `POST /api/app/planner/voice/transcribe` | the clip, `content-type: audio/*` (8 MB max)                        | `{ text, voice }`                                       |
| `POST /api/app/planner/voice/speak`      | `{ text }` (markdown and links are stripped, 1,900 characters read) | `audio/mpeg`, header `X-Review-Voice: natural or basic` |

## Files

- `apps/worker/src/fork/review-voice.ts` (+ test): mode, the model calls,
  fallback, text tidying.
- `apps/worker/src/routes/planner-voice-api.ts`, one mount line in
  `planner-api.ts`, the `FLAREMO_REVIEW_VOICE` line in `env.ts`.
- `apps/web/src/planner/review-voice.ts`: the API client and the loop
  (`usePlannerReviewVoice`: playback through an AudioContext unlocked by the
  Talk tap, MediaRecorder, quiet detection).
- `apps/web/src/planner/review-voice-bar.tsx` (+ test): the bar.
- `apps/web/src/planner/review-back.tsx`: the Talk button in the answer box and
  what each message reads out (`voiceLine`). Strings in `goals-strings.ts`
  (`review.voice`), the bar's sway in `goals.css`.
- `tests/e2e/review-voice.spec.ts` with a fake microphone clip in
  `tests/e2e/fixtures/`; the two voice calls are answered by the test, since
  Workers AI does not run in the local Worker.

No table, no migration, nothing for the data-sources registry: nothing is
stored.

## Undo

Set `FLAREMO_REVIEW_VOICE=off` to hide it. To remove it, revert the commit
"Talk: the weekly review by voice".
