import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { MockBrain } from "../../src/brain/mock.js";
import { loadCharacter } from "../../src/character.js";
import { ROOT_DIR } from "../../src/config.js";
import { startEngine, type Engine } from "../../src/engine.js";
import { missingLive2dFiles } from "../../src/live2d.js";
import { renderShort } from "../../src/studio/render.js";
import { BabbleVoice } from "../../src/voice/voices.js";
import { tempDir, testConfig, waitFor } from "../helpers.js";

// Needs the Live2D files from `npm run setup:live2d -- --accept`; skipped without them.
const kikoFile = path.join(ROOT_DIR, "characters", "kiko.yaml");
const kiko = loadCharacter(kikoFile);
const missing = kiko.avatar.type === "live2d" ? missingLive2dFiles(ROOT_DIR, kiko.avatar) : ["not a live2d character"];
const skip = missing.length > 0 ? `Live2D files not installed (${missing.join(", ")})` : false;
const gpuArgs = ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"];

let engine: Engine;
let browser: Browser;

before(async () => {
  if (skip) return;
  engine = await startEngine(testConfig({ CHARACTER_FILE: kikoFile }), {
    brain: new MockBrain(kiko, { latencyMs: 200 }),
    sources: [],
    idleChatter: false,
    timing: { minGapMs: 50, playbackGraceMs: 4000 },
  });
  browser = await chromium.launch({ args: gpuArgs, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
});

after(async () => {
  await browser?.close();
  await engine?.stop();
});

test("Kiko's Live2D model loads, speaks and reports playback", { skip, timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${engine.server.url}/avatar`);
  await page.waitForSelector("canvas.avatar-live2d", { timeout: 30_000 });
  assert.equal(await page.isHidden("#problem"), true, "no load-error banner");

  await fetch(`${engine.server.url}/api/chat`, { method: "POST", body: JSON.stringify({ user: "e2e_viewer", text: "kiko judge my setup" }) });
  await page.waitForSelector(".captions.visible", { timeout: 15_000 });
  const exchange = await waitFor(() => engine.session.exchanges()[0], 20_000, "exchange");
  assert.match(exchange.say, /Verdict: (Approved|Patched|Deprecated|Deleted)|e2e_viewer/);
  assert.deepEqual(errors, []);
});

test("renders a Live2D Short", { skip, timeout: 240_000 }, async () => {
  const audio = await new BabbleVoice(1.4).synthesize("Verdict: Approved. Ticket closed.", "happy");
  const outFile = path.join(tempDir(), "kiko-short.mp4");
  const result = await renderShort(
    { title: "Chat asked an AI girl", question: { user: "tester", text: "kiko rate my code", platform: "twitch" }, lines: [{ text: "Verdict: Approved. Ticket closed.", emotion: "happy", audio: audio.data }], outFile },
    { rootDir: ROOT_DIR, character: kiko, ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg", chromiumPath: process.env.CHROMIUM_PATH, fps: 15 },
  );
  assert.ok(fs.statSync(outFile).size > 30_000);
  assert.equal(result.frames, Math.ceil(result.durationSec * 15));
});
