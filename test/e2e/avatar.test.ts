import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { MockBrain } from "../../src/brain/mock.js";
import { startEngine, type Engine } from "../../src/engine.js";
import { crumb, testConfig, waitFor } from "../helpers.js";

let engine: Engine;
let browser: Browser;

before(async () => {
  engine = await startEngine(testConfig(), {
    brain: new MockBrain(crumb(), { latencyMs: 300 }),
    sources: [],
    idleChatter: false,
    timing: { minGapMs: 50, playbackGraceMs: 4000 },
  });
  browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required"],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
});

after(async () => {
  await browser?.close();
  await engine?.stop();
});

test("the avatar page plays a reply end to end and reports playback back", { timeout: 30_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${engine.server.url}/avatar`);
  await page.waitForSelector("svg.avatar-svg");

  await fetch(`${engine.server.url}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ user: "e2e_viewer", text: "crumb roast my setup" }),
  });

  await page.waitForSelector(".captions.visible", { timeout: 10_000 });
  const question = await page.textContent(".cap-question");
  assert.match(question ?? "", /e2e_viewer.*crumb roast my setup/);

  // The page acknowledges when the audio finishes; the turn closes without waiting for the timeout.
  const exchange = await waitFor(() => engine.session.exchanges()[0], 15_000, "exchange");
  assert.equal(exchange.interrupted, undefined);
  const caption = await page.textContent(".cap-text");
  assert.equal(caption?.replace(/\s+/g, " ").trim(), exchange.say);
  assert.deepEqual(errors, []);
});

test("the console loads, shows the exchange and can pause the show", { timeout: 20_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${engine.server.url}/console`);
  await page.waitForSelector("#exchanges li");
  assert.match((await page.textContent("#char-name")) ?? "", /Crumb/);

  await page.click("#pause");
  await waitFor(() => engine.director.status().paused, 3000, "pause");
  await page.waitForFunction(() => document.getElementById("pause")?.textContent === "Resume");
  await page.click("#pause");
  await waitFor(() => !engine.director.status().paused, 3000, "resume");
  assert.deepEqual(errors, []);
});
