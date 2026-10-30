import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";
import { BabbleVoice, ElevenLabsVoice, OpenAiCompatibleVoice, renderBabble } from "../src/voice/voices.js";
import { decodeWavPcm16, encodeWav, parseWav } from "../src/voice/wav.js";

describe("WAV", () => {
  test("round-trips samples and reports duration", () => {
    const samples = new Float32Array(24_000).map((_, i) => Math.sin(i / 10) * 0.5);
    const wav = encodeWav(samples, 24_000);
    const info = parseWav(wav);
    assert.equal(info.sampleRate, 24_000);
    assert.equal(info.durationMs, 1000);
    const decoded = decodeWavPcm16(wav);
    assert.equal(decoded.samples.length, samples.length);
    assert.ok(Math.abs((decoded.samples[100] ?? 0) - (samples[100] ?? 0)) < 0.001);
  });

  test("rejects non-WAV data", () => {
    assert.throws(() => parseWav(Buffer.from("ID3 not a wav")));
  });
});

describe("babble voice", () => {
  test("is deterministic and roughly paced like speech", async () => {
    const a = renderBabble("Rated: Burnt. Ding!", "smug");
    const b = renderBabble("Rated: Burnt. Ding!", "smug");
    assert.deepEqual(a, b);
    const audio = await new BabbleVoice().synthesize("This is a sentence with about ten words in it.", "neutral");
    assert.equal(audio.mime, "audio/wav");
    assert.ok(audio.durationMs > 1500 && audio.durationMs < 6000, `duration ${audio.durationMs}`);
  });
});

async function withServer(handler: http.RequestListener, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(JSON.parse(body)));
  });
}

describe("API voices", () => {
  test("ElevenLabs: sends key, model and text; returns mp3", async () => {
    let seen: { url?: string; key?: string; body?: Record<string, any> } = {};
    await withServer(
      async (req, res) => {
        seen = { url: req.url, key: req.headers["xi-api-key"] as string, body: await readBody(req) };
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(Buffer.alloc(32_000));
      },
      async (base) => {
        const voice = new ElevenLabsVoice({ apiKey: "k", voiceId: "v1", model: "eleven_flash_v2_5", baseUrl: base });
        const audio = await voice.synthesize("Hello chat", "excited");
        assert.equal(audio.ext, "mp3");
        assert.equal(audio.durationMs, 2000);
      },
    );
    assert.equal(seen.url, "/v1/text-to-speech/v1?output_format=mp3_44100_128");
    assert.equal(seen.key, "k");
    assert.equal(seen.body?.text, "Hello chat");
    assert.equal(seen.body?.model_id, "eleven_flash_v2_5");
  });

  test("OpenAI-compatible: requests WAV and reads its real duration", async () => {
    let body: Record<string, any> = {};
    await withServer(
      async (req, res) => {
        body = await readBody(req);
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(encodeWav(new Float32Array(12_000), 24_000));
      },
      async (base) => {
        const voice = new OpenAiCompatibleVoice({ baseUrl: base, model: "kokoro", voice: "af_bella" });
        const audio = await voice.synthesize("Hi", "happy");
        assert.equal(audio.durationMs, 500);
      },
    );
    assert.equal(body.response_format, "wav");
    assert.equal(body.voice, "af_bella");
    assert.equal(body.instructions, undefined);
  });

  test("API errors carry the status", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(401);
        res.end("bad key");
      },
      async (base) => {
        const voice = new OpenAiCompatibleVoice({ baseUrl: base, model: "gpt-4o-mini-tts", voice: "alloy" });
        await assert.rejects(voice.synthesize("Hi", "happy"), /401: bad key/);
      },
    );
  });
});
