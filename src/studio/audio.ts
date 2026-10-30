import { spawn } from "node:child_process";
import { decodeWavPcm16 } from "../voice/wav.js";

export const STUDIO_RATE = 48_000;

function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const out = new Float32Array(Math.round((samples.length * to) / from));
  const ratio = from / to;
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = samples[index] ?? 0;
    const b = samples[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Decodes any audio (WAV, MP3, …) to mono float samples at `rate`. Needs ffmpeg for anything but 16-bit WAV. */
export async function decodeAudio(input: Buffer, ffmpegPath: string, rate = STUDIO_RATE): Promise<Float32Array> {
  try {
    const { samples, sampleRate } = decodeWavPcm16(input);
    return resample(samples, sampleRate, rate);
  } catch {
    // Not a plain PCM WAV; let ffmpeg handle it.
  }
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", String(rate), "pipe:1"]);
    const chunks: Buffer[] = [];
    let stderr = "";
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    ffmpeg.on("error", (error) => reject(new Error(`could not run ffmpeg (${ffmpegPath}): ${error.message}`)));
    ffmpeg.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode the audio: ${stderr.trim()}`));
      const raw = Buffer.concat(chunks);
      const samples = new Float32Array(Math.floor(raw.length / 4));
      for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4);
      resolve(samples);
    });
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.end(input);
  });
}

/** Lays clips onto a timeline of `length` samples. */
export function mix(length: number, parts: { samples: Float32Array; at: number; gain?: number }[], rate = STUDIO_RATE): Float32Array {
  const out = new Float32Array(length);
  for (const part of parts) {
    const offset = Math.round(part.at * rate);
    const gain = part.gain ?? 1;
    for (let i = 0; i < part.samples.length; i++) {
      const target = offset + i;
      if (target < 0 || target >= length) continue;
      out[target] = (out[target] ?? 0) + (part.samples[i] ?? 0) * gain;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] ?? 0));
  return out;
}

/** The toaster "ding". */
export function dingSound(rate = STUDIO_RATE): Float32Array {
  const out = new Float32Array(Math.round(rate * 0.9));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = 0.16 * Math.sin(2 * Math.PI * 1568 * t) * Math.exp(-t * 5.5) + 0.05 * Math.sin(2 * Math.PI * 3136 * t) * Math.exp(-t * 7);
  }
  return out;
}

/**
 * Mouth openness per video frame, 0..1. Uses the same scaling as the live
 * avatar page so renders and streams move the same way.
 */
export function envelope(samples: Float32Array, rate: number, fps: number, frames: number): number[] {
  const hop = rate / fps;
  const half = Math.round(rate * 0.02);
  const levels: number[] = [];
  for (let f = 0; f < frames; f++) {
    const center = Math.round(f * hop + hop / 2);
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, center - half); i < Math.min(samples.length, center + half); i++) {
      const v = samples[i] ?? 0;
      sum += v * v;
      n++;
    }
    const rms = n > 0 ? Math.sqrt(sum / n) : 0;
    levels.push(rms < 0.015 ? 0 : Math.min(1, Number((rms * 4.5).toFixed(3))));
  }
  return levels;
}
