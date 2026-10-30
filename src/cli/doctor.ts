import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";
import { loadCharacter } from "../character.js";
import { loadConfig, loadDotEnv } from "../config.js";
import { createBrain } from "../engine.js";
import { errorMessage } from "../log.js";
import { createVoice } from "../voice/voices.js";

type Status = "ok" | "warn" | "fail";
const marks: Record<Status, string> = { ok: "  ok  ", warn: " note ", fail: " FAIL " };
let failures = 0;

function report(status: Status, label: string, detail: string): void {
  if (status === "fail") failures += 1;
  console.log(`[${marks[status]}] ${label.padEnd(14)} ${detail}`);
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function main(): Promise<void> {
  const ping = process.argv.includes("--ping");
  loadDotEnv();
  const config = loadConfig();
  console.log("\nChecking your setup...\n");

  const major = Number(process.versions.node.split(".")[0]);
  report(major >= 22 ? "ok" : "fail", "Node.js", `v${process.versions.node}${major >= 22 ? "" : " (need 22 or newer)"}`);
  report(fs.existsSync(path.join(config.rootDir, ".env")) ? "ok" : "warn", ".env", fs.existsSync(path.join(config.rootDir, ".env")) ? "found" : "not found - copy .env.example to .env");

  let character;
  try {
    character = loadCharacter(config.characterFile);
    report("ok", "Character", `${character.name} (${path.relative(config.rootDir, config.characterFile)})`);
  } catch (error) {
    report("fail", "Character", errorMessage(error));
  }

  if (config.brain === "claude") {
    report("ok", "Brain", `Claude, model ${config.claudeModel}, live effort ${config.effortLive}, budget $${config.dailyBudgetUsd}/run`);
    if (ping && character) {
      try {
        const brain = createBrain(config, character);
        const reply = await brain.reply({ kind: "handler", text: "Quick mic check. Say hi to chat in one sentence." }, { recent: [], viewerNotes: [], lore: [] });
        report("ok", "Brain ping", `[${reply.emotion}] ${reply.say}`);
      } catch (error) {
        report("fail", "Brain ping", errorMessage(error));
      }
    }
  } else {
    report("warn", "Brain", "offline mock (canned lines). Add ANTHROPIC_API_KEY to .env for real replies");
  }

  if (character) {
    try {
      const voice = createVoice(config, character);
      report(config.tts.provider === "babble" ? "warn" : "ok", "Voice", voice ? `${voice.name}${config.tts.provider === "babble" ? " - fine for testing; set TTS_PROVIDER for a real voice" : ""}` : "off (silent captions)");
    } catch (error) {
      report("fail", "Voice", errorMessage(error));
    }
  }

  const chats = [
    config.twitchChannel ? `twitch #${config.twitchChannel}` : "",
    config.youtube.videoId ? `youtube ${config.youtube.videoId}${config.youtube.apiKey || config.youtube.oauthToken ? "" : " (missing YOUTUBE_API_KEY)"}` : "",
  ].filter(Boolean);
  report(chats.length > 0 ? "ok" : "warn", "Chat", chats.length > 0 ? chats.join(", ") : "no live chat configured (set TWITCH_CHANNEL); demo/test chat still works");

  const ffmpeg = spawnSync(config.ffmpegPath, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (ffmpeg.error || ffmpeg.status !== 0) {
    report("fail", "ffmpeg", `not found (${config.ffmpegPath}). Needed for Shorts. Install it or set FFMPEG_PATH`);
  } else {
    report(ffmpeg.stdout.includes("libx264") ? "ok" : "fail", "ffmpeg", ffmpeg.stdout.includes("libx264") ? "found, with H.264" : "found, but without libx264");
  }

  try {
    const browser = await chromium.launch(config.chromiumPath ? { executablePath: config.chromiumPath } : {});
    await browser.close();
    report("ok", "Chromium", "launches (used to render Shorts)");
  } catch (error) {
    report("fail", "Chromium", `${errorMessage(error).split("\n")[0]} - run: npx playwright install chromium`);
  }

  report((await portFree(config.port, config.host)) ? "ok" : "fail", "Port", `${config.host}:${config.port}${(await portFree(config.port, config.host)) ? " is free" : " is in use (set PORT)"}`);

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
    report("ok", "Data folder", path.relative(process.cwd(), config.dataDir) || config.dataDir);
  } catch (error) {
    report("fail", "Data folder", errorMessage(error));
  }

  console.log(failures === 0 ? "\nAll set. Start with: npm run demo\n" : `\n${failures} problem(s) to fix first.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`doctor: ${errorMessage(error)}`);
  process.exit(1);
});
