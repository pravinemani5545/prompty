import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { publicCharacter, type Character } from "../character.js";
import { serveStatic } from "../server.js";
import type { Emotion } from "../types.js";
import { silentDurationMs } from "../voice/voices.js";
import { encodeWav } from "../voice/wav.js";
import { STUDIO_RATE, decodeAudio, dingSound, envelope, mix } from "./audio.js";

export interface ShortLine {
  text: string;
  emotion: Emotion;
  /** Speech audio in any format ffmpeg can read; null renders the line silently. */
  audio: Buffer | null;
}

export interface ShortInput {
  /** On-screen hook text at the top. */
  title: string;
  question?: { user: string; text: string; platform: string };
  lines: ShortLine[];
  outFile: string;
}

export interface RenderOptions {
  rootDir: string;
  character: Character;
  ffmpegPath: string;
  chromiumPath?: string;
  fps?: number;
  width?: number;
  height?: number;
  onProgress?: (frame: number, total: number) => void;
}

export interface RenderResult {
  file: string;
  durationSec: number;
  frames: number;
}

/** Seconds the question card is on screen (character "toasting") before the first line. */
const INTRO_WITH_QUESTION = 1.5;
const INTRO_WITHOUT_QUESTION = 0.6;
const GAP_BETWEEN_LINES = 0.3;
const END_CARD_SECONDS = 1.8;

export async function renderShort(input: ShortInput, options: RenderOptions): Promise<RenderResult> {
  if (input.lines.length === 0) throw new Error("a short needs at least one line");
  const fps = options.fps ?? 30;
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;

  // 1. Audio timeline.
  let cursor = input.question ? INTRO_WITH_QUESTION : INTRO_WITHOUT_QUESTION;
  const segments: { start: number; duration: number; text: string; emotion: Emotion; samples: Float32Array }[] = [];
  for (const line of input.lines) {
    const samples = line.audio
      ? await decodeAudio(line.audio, options.ffmpegPath)
      : new Float32Array(Math.round((silentDurationMs(line.text) / 1000) * STUDIO_RATE));
    const duration = samples.length / STUDIO_RATE;
    segments.push({ start: cursor, duration, text: line.text, emotion: line.emotion, samples });
    cursor += duration + GAP_BETWEEN_LINES;
  }
  const endCardStart = cursor - GAP_BETWEEN_LINES + 0.4;
  const durationSec = endCardStart + END_CARD_SECONDS;
  const frames = Math.ceil(durationSec * fps);
  const length = Math.ceil(durationSec * STUDIO_RATE);
  const speech = mix(length, segments.map((s) => ({ samples: s.samples, at: s.start })));
  const levels = envelope(speech, STUDIO_RATE, fps, frames);
  const ding = dingSound();
  const soundtrack = mix(length, [
    { samples: speech, at: 0 },
    { samples: ding, at: Math.max(0, segments[0]!.start - 0.15) },
    { samples: ding, at: endCardStart, gain: 0.7 },
  ]);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "short-"));
  const wavPath = path.join(work, "audio.wav");
  fs.writeFileSync(wavPath, encodeWav(soundtrack, STUDIO_RATE));
  fs.mkdirSync(path.dirname(path.resolve(input.outFile)), { recursive: true });

  const character = options.character;
  const spec = {
    width,
    height,
    fps,
    frames,
    character: publicCharacter(character),
    title: input.title,
    question: input.question ?? null,
    segments: segments.map(({ start, duration, text, emotion }) => ({ start, duration, text, emotion })),
    envelope: levels,
    endCard: {
      start: endCardStart,
      line1: character.catchphrases[0] ?? character.name,
      line2: `Follow ${character.socials.handle}`,
      line3: character.socials.cta,
    },
  };

  // 2. Serve the render page locally and drive it frame by frame.
  const mounts = { webDir: path.join(options.rootDir, "web"), assetsDir: path.join(options.rootDir, "assets") };
  const server = http.createServer((req, res) => {
    if (!serveStatic(req, res, mounts)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const browser = await chromium.launch(options.chromiumPath ? { executablePath: options.chromiumPath } : {});
  let ffmpeg: ReturnType<typeof spawn> | undefined;
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/short`);
    await page.waitForFunction(() => (window as unknown as { shortRenderer?: { ready: boolean } }).shortRenderer?.ready === true);
    await page.evaluate((s) => (window as unknown as { shortRenderer: { setup(spec: unknown): void } }).shortRenderer.setup(s), spec);
    if (pageErrors.length > 0) throw new Error(`render page error: ${pageErrors[0]}`);

    let stderr = "";
    ffmpeg = spawn(options.ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0",
      "-i", wavPath,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart",
      path.resolve(input.outFile),
    ]);
    ffmpeg.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = once(ffmpeg, "close");
    const stdin = ffmpeg.stdin!;
    stdin.on("error", () => {});

    for (let i = 0; i < frames; i++) {
      await page.evaluate((frame) => (window as unknown as { shortRenderer: { frame(i: number): void } }).shortRenderer.frame(frame), i);
      const jpeg = await page.screenshot({ type: "jpeg", quality: 92 });
      if (!stdin.write(jpeg)) await once(stdin, "drain");
      options.onProgress?.(i + 1, frames);
    }
    stdin.end();
    const [code] = (await exited) as [number | null];
    if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${stderr.trim()}`);
    if (pageErrors.length > 0) throw new Error(`render page error: ${pageErrors[0]}`);
  } finally {
    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { file: path.resolve(input.outFile), durationSec, frames };
}
