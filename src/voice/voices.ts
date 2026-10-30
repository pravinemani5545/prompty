import type { Character } from "../character.js";
import type { Config } from "../config.js";
import type { Emotion, SpeechAudio } from "../types.js";
import { encodeWav, parseWav } from "./wav.js";

export interface Voice {
  readonly name: string;
  synthesize(text: string, emotion: Emotion): Promise<SpeechAudio>;
}

const EMOTION_PITCH: Record<Emotion, number> = {
  neutral: 1,
  happy: 1.1,
  excited: 1.22,
  smug: 0.92,
  surprised: 1.28,
  angry: 0.94,
  sad: 0.84,
  embarrassed: 1.14,
};

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function syllableCount(word: string): number {
  const groups = word.toLowerCase().match(/[aeiouy]+/g)?.length ?? 1;
  return Math.max(1, Math.min(4, groups));
}

/**
 * Animal Crossing style gibberish: one pitched blip per syllable. Deterministic
 * for a given text, so renders are reproducible and tests are stable.
 */
export function renderBabble(text: string, emotion: Emotion, pitch = 1, sampleRate = 24_000): Float32Array {
  let seed = hash(text) || 1;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const base = 205 * pitch * EMOTION_PITCH[emotion];
  const tokens = text.match(/[\p{L}\p{N}']+|[.,!?;:]/gu) ?? [];
  const parts: number[][] = [];
  const silence = (seconds: number) => parts.push(new Array(Math.round(seconds * sampleRate)).fill(0));

  const asks = text.trim().endsWith("?");
  tokens.forEach((token, index) => {
    if (/^[.!?]$/.test(token)) return silence(0.2);
    if (/^[,;:]$/.test(token)) return silence(0.11);
    const nearEnd = index >= tokens.length - 3;
    for (let s = 0, n = syllableCount(token); s < n; s++) {
      const duration = 0.065 + random() * 0.05;
      const rise = asks && nearEnd ? 1.15 : 1;
      const frequency = base * (0.84 + random() * 0.36) * rise;
      const count = Math.round(duration * sampleRate);
      const blip = new Array<number>(count);
      for (let i = 0; i < count; i++) {
        const t = i / sampleRate;
        const attack = Math.min(1, t / 0.008);
        const release = Math.min(1, (duration - t) / 0.025);
        const envelope = Math.max(0, Math.min(attack, release));
        const vibrato = 1 + 0.012 * Math.sin(2 * Math.PI * 6 * t);
        const phase = 2 * Math.PI * frequency * vibrato * t;
        const tone = 0.55 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase);
        blip[i] = 0.42 * envelope * tone * (1 + 0.25 * Math.sin(2 * Math.PI * 9 * t));
      }
      parts.push(blip);
      silence(0.016);
    }
    silence(0.055);
  });
  silence(0.08);

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class BabbleVoice implements Voice {
  readonly name = "babble (offline)";
  constructor(
    private readonly pitch = 1,
    private readonly sampleRate = 24_000,
  ) {}

  async synthesize(text: string, emotion: Emotion): Promise<SpeechAudio> {
    const samples = renderBabble(text, emotion, this.pitch, this.sampleRate);
    return {
      data: encodeWav(samples, this.sampleRate),
      ext: "wav",
      mime: "audio/wav",
      durationMs: Math.round((samples.length / this.sampleRate) * 1000),
    };
  }
}

async function failure(service: string, response: Response): Promise<Error> {
  const body = (await response.text().catch(() => "")).slice(0, 300);
  return new Error(`${service} returned ${response.status}${body ? `: ${body}` : ""}`);
}

export class ElevenLabsVoice implements Voice {
  readonly name: string;

  constructor(private readonly options: { apiKey: string; voiceId: string; model: string; baseUrl?: string }) {
    this.name = `elevenlabs (${options.model})`;
  }

  async synthesize(text: string, emotion: Emotion): Promise<SpeechAudio> {
    // Lower stability = more expressive delivery for the big emotions.
    const expressive = emotion === "excited" || emotion === "surprised" || emotion === "angry";
    const base = this.options.baseUrl ?? "https://api.elevenlabs.io";
    const response = await fetch(
      `${base}/v1/text-to-speech/${encodeURIComponent(this.options.voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": this.options.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: this.options.model,
          voice_settings: { stability: expressive ? 0.3 : 0.45, similarity_boost: 0.8, use_speaker_boost: true },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw await failure("ElevenLabs", response);
    const data = Buffer.from(await response.arrayBuffer());
    // 128 kbps constant bitrate is 16,000 bytes per second.
    return { data, ext: "mp3", mime: "audio/mpeg", durationMs: Math.round((data.length / 16_000) * 1000) };
  }
}

/** Any OpenAI-compatible /audio/speech endpoint: OpenAI itself, or a local Kokoro-FastAPI server. */
export class OpenAiCompatibleVoice implements Voice {
  readonly name: string;

  constructor(private readonly options: { baseUrl: string; apiKey?: string; model: string; voice: string }) {
    this.name = `openai-compatible (${options.model}/${options.voice})`;
  }

  async synthesize(text: string, emotion: Emotion): Promise<SpeechAudio> {
    const steerable = this.options.model.startsWith("gpt-4o");
    const response = await fetch(`${this.options.baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        voice: this.options.voice,
        input: text,
        response_format: "wav",
        ...(steerable ? { instructions: `Playful livestream character. Emotion: ${emotion}.` } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw await failure("TTS endpoint", response);
    const data = Buffer.from(await response.arrayBuffer());
    return { data, ext: "wav", mime: "audio/wav", durationMs: parseWav(data).durationMs };
  }
}

/** Returns null when TTS is turned off: the avatar then mouths along to the captions silently. */
export function createVoice(config: Config, character: Character): Voice | null {
  const tts = config.tts;
  switch (tts.provider) {
    case "none":
      return null;
    case "babble":
      return new BabbleVoice(character.voice.babblePitch);
    case "elevenlabs": {
      const voiceId = character.voice.elevenlabsVoiceId ?? tts.elevenlabs.voiceId;
      if (!tts.elevenlabs.apiKey || !voiceId) {
        throw new Error("TTS_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID (or voice.elevenlabsVoiceId in the character file)");
      }
      return new ElevenLabsVoice({ apiKey: tts.elevenlabs.apiKey, voiceId, model: tts.elevenlabs.model });
    }
    case "openai":
      return new OpenAiCompatibleVoice({
        baseUrl: tts.openai.baseUrl,
        apiKey: tts.openai.apiKey,
        model: tts.openai.model,
        voice: character.voice.openaiVoice ?? tts.openai.voice,
      });
  }
}

/** Speaking time to assume when there is no audio, so captions and turn timing still work. */
export function silentDurationMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1200, Math.round((words / 2.8) * 1000));
}
