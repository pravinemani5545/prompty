import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCharacter, type Character } from "../src/character.js";
import { ROOT_DIR, loadConfig, type Config } from "../src/config.js";
import type { ChatMessage } from "../src/types.js";

export function tempDir(prefix = "vtuber-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function crumb(): Character {
  return loadCharacter(path.join(ROOT_DIR, "characters", "crumb.yaml"));
}

/** A config that never touches real services: mock brain, babble voice, temp data dir, random port, Crumb (no downloads needed). */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    BRAIN: "mock",
    TTS_PROVIDER: "babble",
    PORT: "0",
    DATA_DIR: tempDir(),
    CHARACTER_FILE: path.join(ROOT_DIR, "characters", "crumb.yaml"),
    ...overrides,
  });
}

let n = 0;
export function chat(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  n += 1;
  return { id: `t${n}`, platform: "twitch", user: "viewer", text, ts: Date.now(), badges: {}, ...extra };
}

export async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 5000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
