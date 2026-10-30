import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { Memory } from "../src/memory.js";
import { STUDIO_RATE, decodeAudio, envelope, mix } from "../src/studio/audio.js";
import { BabbleVoice } from "../src/voice/voices.js";
import { tempDir } from "./helpers.js";

describe("memory", () => {
  test("remembers viewers and running bits across restarts", () => {
    const file = path.join(tempDir(), "memory.json");
    const memory = new Memory(file);
    for (let i = 0; i < 5; i++) memory.touch("twitch", "Regular_Rita");
    memory.recordReply("twitch", "Regular_Rita");
    memory.remember("Owns a sourdough starter named Kevin.", { platform: "twitch", user: "regular_rita" });
    memory.remember("owns a sourdough starter named kevin.", { platform: "twitch", user: "Regular_Rita" });
    memory.remember("Chat decided the Microwave owes everyone money.");
    memory.flush();

    const reloaded = new Memory(file);
    assert.equal(reloaded.isRegular("twitch", "regular_rita"), true);
    assert.equal(reloaded.isRegular("twitch", "someone_new"), false);
    assert.deepEqual(reloaded.notesFor("twitch", "Regular_Rita").slice(1), ["Owns a sourdough starter named Kevin."]);
    assert.match(reloaded.notesFor("twitch", "Regular_Rita")[0]!, /Has chatted 5 times/);
    assert.deepEqual(reloaded.lore(), ["Chat decided the Microwave owes everyone money."]);
  });

  test("caps notes per viewer", () => {
    const memory = new Memory(null);
    memory.touch("demo", "x");
    for (let i = 0; i < 10; i++) memory.remember(`fact ${i}`, { platform: "demo", user: "x" });
    assert.deepEqual(memory.viewer("demo", "x")?.notes, ["fact 4", "fact 5", "fact 6", "fact 7", "fact 8", "fact 9"]);
  });
});

describe("studio audio", () => {
  test("mixes clips at offsets and measures mouth movement per frame", async () => {
    const tone = new Float32Array(STUDIO_RATE / 2).fill(0.3);
    const track = mix(STUDIO_RATE * 2, [{ samples: tone, at: 1 }]);
    assert.equal(track[STUDIO_RATE / 2], 0);
    assert.ok(Math.abs((track[STUDIO_RATE + 10] ?? 0) - 0.3) < 1e-6);
    const levels = envelope(track, STUDIO_RATE, 30, 60);
    assert.equal(levels.length, 60);
    assert.equal(levels[10], 0);
    assert.ok((levels[35] ?? 0) > 0.9);
    assert.ok(levels.every((v) => v >= 0 && v <= 1));
  });

  test("decodes our own WAV without ffmpeg and resamples it", async () => {
    const audio = await new BabbleVoice().synthesize("Ding! You're done.", "happy");
    const samples = await decodeAudio(audio.data, "ffmpeg-is-not-needed-here");
    const seconds = samples.length / STUDIO_RATE;
    assert.ok(Math.abs(seconds * 1000 - audio.durationMs) < 5, `${seconds}s vs ${audio.durationMs}ms`);
  });
});
