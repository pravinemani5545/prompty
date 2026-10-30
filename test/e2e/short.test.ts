import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT_DIR } from "../../src/config.js";
import { renderShort } from "../../src/studio/render.js";
import { BabbleVoice } from "../../src/voice/voices.js";
import { crumb, tempDir } from "../helpers.js";

test("renders a 1080x1920 H.264 + AAC Short with the right length", { timeout: 120_000 }, async () => {
  const voice = new BabbleVoice(1.15);
  const lines = [
    { text: "Tabs versus spaces? Oh, you came to the right appliance.", emotion: "smug" as const },
    { text: "Rated: Charcoal. Ding! You're done.", emotion: "happy" as const },
  ];
  const audio = await Promise.all(lines.map((l) => voice.synthesize(l.text, l.emotion)));
  const outFile = path.join(tempDir(), "test-short.mp4");

  const result = await renderShort(
    {
      title: "An AI toaster rates tabs vs spaces",
      question: { user: "breadwinner_99", text: "crumb, tabs or spaces?", platform: "twitch" },
      lines: lines.map((l, i) => ({ ...l, audio: audio[i]!.data })),
      outFile,
    },
    { rootDir: ROOT_DIR, character: crumb(), ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg", chromiumPath: process.env.CHROMIUM_PATH, fps: 24 },
  );

  assert.ok(fs.statSync(outFile).size > 50_000);
  const probe = spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration", "-of", "json", outFile], { encoding: "utf8" });
  const info = JSON.parse(probe.stdout) as { streams: { codec_name: string; width?: number; height?: number }[]; format: { duration: string } };
  const video = info.streams.find((s) => s.codec_name === "h264");
  assert.ok(video, "has an H.264 stream");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.ok(info.streams.some((s) => s.codec_name === "aac"), "has an AAC stream");

  const speech = audio.reduce((sum, a) => sum + a.durationMs, 0) / 1000;
  const duration = Number(info.format.duration);
  // Intro (1.5s) + speech + gap (0.3s) + end card (0.4s + 1.8s).
  assert.ok(Math.abs(duration - (1.5 + speech + 0.3 + 2.2)) < 0.3, `duration ${duration}s for ${speech}s of speech`);
  assert.equal(result.frames, Math.ceil(result.durationSec * 24));
});
