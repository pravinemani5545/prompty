import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Effort = "low" | "medium" | "high";
export type BrainMode = "auto" | "claude" | "mock";
export type TtsProvider = "babble" | "elevenlabs" | "openai" | "none";

export interface Config {
  rootDir: string;
  dataDir: string;
  brain: "claude" | "mock";
  claudeModel: string;
  effortLive: Effort;
  effortScripts: Effort;
  dailyBudgetUsd: number;
  characterFile: string;
  tts: {
    provider: TtsProvider;
    elevenlabs: { apiKey?: string; voiceId?: string; model: string };
    openai: { baseUrl: string; apiKey?: string; model: string; voice: string };
  };
  twitchChannel?: string;
  youtube: { videoId?: string; apiKey?: string; oauthToken?: string; minPollSeconds: number };
  port: number;
  host: string;
  reviewMode: boolean;
  ingestToken?: string;
  ffmpegPath: string;
  chromiumPath?: string;
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Loads `.env` from the project root (if present) into process.env without overriding real env vars. */
export function loadDotEnv(rootDir = ROOT_DIR): void {
  const file = path.join(rootDir, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, key: string): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${key} must be one of ${allowed.join(", ")} (got "${value}")`);
}

function num(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number (got "${value}")`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = ROOT_DIR): Config {
  const brainMode = oneOf<BrainMode>(str(env, "BRAIN"), ["auto", "claude", "mock"], "auto", "BRAIN");
  const hasClaudeCredentials = Boolean(str(env, "ANTHROPIC_API_KEY") || str(env, "ANTHROPIC_AUTH_TOKEN"));
  const brain = brainMode === "auto" ? (hasClaudeCredentials ? "claude" : "mock") : brainMode;

  const efforts = ["low", "medium", "high"] as const;
  return {
    rootDir,
    dataDir: path.resolve(rootDir, str(env, "DATA_DIR") ?? "data"),
    brain,
    claudeModel: str(env, "CLAUDE_MODEL") ?? "claude-opus-5-5",
    effortLive: oneOf(str(env, "CLAUDE_EFFORT_LIVE"), efforts, "low", "CLAUDE_EFFORT_LIVE"),
    effortScripts: oneOf(str(env, "CLAUDE_EFFORT_SCRIPTS"), efforts, "medium", "CLAUDE_EFFORT_SCRIPTS"),
    dailyBudgetUsd: num(str(env, "DAILY_BUDGET_USD"), 10, "DAILY_BUDGET_USD"),
    characterFile: path.resolve(rootDir, str(env, "CHARACTER_FILE") ?? "characters/crumb.yaml"),
    tts: {
      provider: oneOf<TtsProvider>(str(env, "TTS_PROVIDER"), ["babble", "elevenlabs", "openai", "none"], "babble", "TTS_PROVIDER"),
      elevenlabs: {
        apiKey: str(env, "ELEVENLABS_API_KEY"),
        voiceId: str(env, "ELEVENLABS_VOICE_ID"),
        model: str(env, "ELEVENLABS_MODEL") ?? "eleven_flash_v2_5",
      },
      openai: {
        baseUrl: (str(env, "OPENAI_TTS_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
        apiKey: str(env, "OPENAI_TTS_API_KEY"),
        model: str(env, "OPENAI_TTS_MODEL") ?? "gpt-4o-mini-tts",
        voice: str(env, "OPENAI_TTS_VOICE") ?? "alloy",
      },
    },
    twitchChannel: str(env, "TWITCH_CHANNEL")?.replace(/^#/, "").toLowerCase(),
    youtube: {
      videoId: str(env, "YOUTUBE_LIVE_VIDEO_ID"),
      apiKey: str(env, "YOUTUBE_API_KEY"),
      oauthToken: str(env, "YOUTUBE_OAUTH_TOKEN"),
      minPollSeconds: num(str(env, "YOUTUBE_MIN_POLL_SECONDS"), 8, "YOUTUBE_MIN_POLL_SECONDS"),
    },
    port: num(str(env, "PORT"), 4870, "PORT"),
    host: str(env, "HOST") ?? "127.0.0.1",
    reviewMode: str(env, "REVIEW_MODE") === "true",
    ingestToken: str(env, "INGEST_TOKEN"),
    ffmpegPath: str(env, "FFMPEG_PATH") ?? "ffmpeg",
    chromiumPath: str(env, "CHROMIUM_PATH"),
  };
}
