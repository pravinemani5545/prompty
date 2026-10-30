# AI VTuber Engine

A live, chat-driven AI VTuber you can stream with. It reads Twitch and YouTube chat, picks what to answer, replies in character with Claude, speaks with a TTS voice, animates an avatar in OBS, and logs every moment so you can turn the best ones into vertical Shorts with one command.

It ships with two characters:

- **Kiko** (the default): an anime-style AI girl who escaped customer support and now hands out verdicts (Approved, Patched, Deprecated, Deleted) on whatever chat sends her. She's a Live2D model with lip sync, 8 emotions, blinking, idle animation and hair physics. Her body is Live2D's free sample model Hiyori, a stand-in until you commission your own. It needs a one-time download (see [Avatars](#avatars)).
- **Crumb**: an AI toaster mascot drawn in SVG, with nothing to download. It's also what the avatar page falls back to if a Live2D model fails to load.

## What's in the box

- **Brain**: Claude replies in character, from a persona file you write in plain YAML. Replies come back as structured JSON (what to say plus which expression to show), the persona prompt is cached, and long-term memory remembers regulars and running bits between streams.
- **Safety rails**: chat is screened before the AI sees it (slurs, profanity, prompt injection, links, personal info, spam). Messages that look like a viewer in crisis are never answered by the AI and raise an alert in your console. Replies are screened again before they're spoken. You also get a kill switch, a skip button and an optional review mode where you approve every line.
- **Voice**: ElevenLabs, any OpenAI-compatible speech API (including free local [Kokoro](https://github.com/remsky/Kokoro-FastAPI)), or an offline "babble" voice for testing.
- **Avatar**: a browser source for OBS with lip sync from the real audio, 8 expressions, blinking and captions. It supports Live2D anime models (the standard VTuber format), PNGtuber art (mouth open/closed per emotion), or the built-in SVG mascot.
- **Operator console**: live chat with safety verdicts, the queue of what gets answered next, push-to-talk so you can talk to your character on stream, expression buttons, clip markers and a running cost estimate.
- **Shorts studio**: renders 1080×1920 MP4s with the avatar, the chat question, karaoke captions and an end card. It works from saved stream moments (no API calls) or from a topic Claude scripts for you.

![Crumb in a rendered Short](docs/img/short-strip.jpg)

## Quick start

You need [Node.js 22+](https://nodejs.org) and, for Shorts, [ffmpeg](https://ffmpeg.org/download.html).

```bash
npm install
npm run setup:live2d              # shows Live2D's terms; add -- --accept to download Kiko's model
npx playwright install chromium   # only needed for Shorts
cp .env.example .env              # optional: works offline without it
npm run doctor                    # checks your setup
npm run demo                      # starts the engine with a fake audience
```

Open the two URLs it prints:

- **Console**: `http://127.0.0.1:4870/console`. Your control room.
- **Avatar**: `http://127.0.0.1:4870/avatar`. Click the page once so the browser allows sound. (OBS doesn't need the click.)

With no keys, the brain is an offline mock that uses canned lines and the voice is babble. That's enough to rehearse the whole setup.

## Go live

1. **Real brain**: put `ANTHROPIC_API_KEY` in `.env`, then run `npm run doctor -- --ping` to get one test reply. The default model is `claude-opus-5-5` (set `CLAUDE_MODEL` to change it). Live replies run at `low` effort so they come back fast. If a request is declined by a safety classifier, Anthropic's server-side fallback retries it on another model, so a false positive doesn't leave dead air.
2. **Real voice**: set `TTS_PROVIDER=elevenlabs` with `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`, or `TTS_PROVIDER=openai` for OpenAI or a local Kokoro server.
3. **Chat**: set `TWITCH_CHANNEL=yourchannel`. This is read-only and needs no login. For YouTube, set `YOUTUBE_LIVE_VIDEO_ID` and `YOUTUBE_API_KEY`. Each poll costs API quota, so leave `YOUTUBE_MIN_POLL_SECONDS` at 8 or more. If YouTube rejects the key for live chat, put an OAuth access token in `YOUTUBE_OAUTH_TOKEN` instead, or relay chat through Social Stream Ninja (see below).
4. **OBS**: add a **Browser** source with URL `http://127.0.0.1:4870/avatar`, size 1080×1080, and tick **Control audio via OBS**. Add `?captions=0` to the URL to hide captions, or `?question=0` to hide the chat question.
5. `npm start`, then open the console.

For your first streams, turn on **review mode** in the console (or `REVIEW_MODE=true`). You approve each reply before it's spoken, which is the safest way to learn what your character does with real chat.

## Turn stream moments into Shorts

During the stream, star (★) the best moments in the console, or press **Mark clip** when chat goes wild. A sudden chat spike also marks a clip automatically. Afterwards:

```bash
npm run short -- --starred                  # every starred moment from your last stream
npm run short -- --clipped                  # every clip marker
npm run short -- --last 3                   # the last three replies
npm run short -- --topic "tabs vs spaces"   # Claude writes a fresh script, then it's voiced and rendered
npm run short -- --say "Rated: Charcoal." --question "roast my code"
```

Videos land in `out/shorts/`, each with a `.txt` holding a suggested caption and hashtags. Rendering takes roughly 2–5× the video length, with Live2D at the slow end on machines without a GPU. Watch every Short before you post it.

Each clip entry in `data/sessions/<date>/session.jsonl` includes `offsetMs`, the time since the engine started, so you can also find the moment in your VOD.

## Make your own character

Copy `characters/kiko.yaml` (or `crumb.yaml`), edit it, and point `CHARACTER_FILE` at it. Everything in that file shapes the persona: identity, personality, how it talks, catchphrases, recurring bits, lore, hard boundaries, idle topics for dead air, and fallback lines.

## Avatars

### Live2D (Kiko's format)

`npm run setup:live2d -- --accept` downloads Live2D's official sample model Hiyori (from Live2D's GitHub) and the Cubism Core runtime (from Live2D's site) into `assets/live2d/`. Those files are git-ignored: Live2D licenses them, not this project. The terms in short:

- Individuals and businesses with annual sales under ¥10 million may use the sample models, including commercially. Larger businesses may not.
- The sample characters' designs may not be changed.
- Read the [Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html), the [sample data terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html) and the [Cubism Core license](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) before you stream with them.

A sample model is fine for launching and testing formats. It isn't unique, though: plenty of AI VTuber demos use Hiyori. For a channel you want to grow, commission your own Live2D model (art plus rigging). Then point the character file at it:

```yaml
avatar:
  type: live2d
  model: /assets/my-model/MyModel.model3.json   # put the exported model in assets/my-model/
  zoom: 2.8          # 1 fits the whole model in frame; higher zooms in
  focusY: 0.24       # which height of the model (0 = top, 1 = bottom) sits mid-frame
  lipSyncParam: ParamMouthOpenY
  expressions:       # optional: map emotions to expressions your rigger made
    happy: Smile
    angry: Angry
```

Emotions also drive Live2D's standard face parameters (eye smile, mouth form, cheeks, brows, gaze), so any model rigged on the standard template emotes even without expression files. In OBS, keep **Use hardware acceleration in browser sources** on (it's the default).

### PNGtuber art

```yaml
avatar:
  type: png
  basePath: /assets/my-character      # put the files in assets/my-character/
  states:
    neutral: { closed: neutral.png, open: neutral_talk.png, blink: neutral_blink.png }
    happy:   { closed: happy.png, open: happy_talk.png }
    # any emotion you skip falls back to neutral
```

Emotions: `neutral`, `happy`, `excited`, `smug`, `surprised`, `angry`, `sad`, `embarrassed`.

### The built-in mascot

`CHARACTER_FILE=characters/crumb.yaml` runs Crumb, which is pure SVG and needs no downloads.

![Crumb live, mid-roast](docs/img/avatar-live.png)

## Hook it up to other tools

- `POST /api/chat` with `{"user": "name", "text": "message", "amount": 5}`: feed in chat from [Streamer.bot](https://streamer.bot), [Social Stream Ninja](https://socialstream.ninja) or anything else. `amount` marks a paid message.
- `POST /api/control` with `{"action": "pause" | "resume" | "skip" | "clip" | "say", "text": "..."}`: works from a Stream Deck button.
- Set `INGEST_TOKEN` and send `Authorization: Bearer <token>` if anything other than your own PC can reach the port.

## Costs

The console shows a running estimate based on token usage. Your Anthropic console has the real numbers. Each reply sends the cached persona (about 1K tokens, read from cache at a fraction of the normal input price) plus recent context and the message. With `claude-opus-5-5` at low effort that works out to roughly a cent per reply. An hour of active chat at three replies a minute is in the region of $1–2. `DAILY_BUDGET_USD` (default $10) caps each run: when the estimate reaches it, the engine switches to the offline brain and logs a warning.

TTS is usually the bigger bill on a busy stream. Check your provider's pricing, or run Kokoro locally for free.

## Project layout

```
characters/      persona files (YAML): kiko.yaml (default), crumb.yaml
assets/          your avatar art; assets/live2d/ holds the downloaded Live2D files
src/brain/       Claude + offline mock, prompts, budget guard
src/chat/        Twitch IRC, YouTube Live, demo audience
src/voice/       ElevenLabs, OpenAI-compatible, babble, WAV helpers
src/director.ts  the show runner: queue -> brain -> safety -> voice -> avatar -> log
src/safety.ts    input/output screening
src/memory.ts    viewers and running bits across streams
src/server.ts    HTTP + WebSocket for the avatar, console and integrations
src/studio/      Shorts renderer (audio timeline + Playwright frames + ffmpeg)
src/live2d.ts    Live2D setup helpers (npm run setup:live2d)
web/             avatar, console and Short pages (plain HTML/JS, no build step); web/js/live2d.js draws Live2D
test/            unit + integration tests; test/e2e/ runs real Chromium and ffmpeg
```

## Tests

```bash
npm test           # unit + integration (no network, no browser)
npm run test:e2e   # real Chromium + ffmpeg: live avatar playback, console, rendered Shorts
                   # (the Live2D ones skip until you've run setup:live2d)
npm run typecheck
```
