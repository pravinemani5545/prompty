export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buffer;
}

/** Reads the header of a WAV file. Tolerates streaming WAVs whose data size is unknown. */
export function parseWav(buffer: Buffer): WavInfo {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let offset = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataBytes" | "durationMs"> | undefined;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before fmt chunk");
      const available = buffer.length - body;
      const dataBytes = size === 0 || size > available ? available : size;
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return { ...fmt, dataOffset: body, dataBytes, durationMs: Math.round((dataBytes / bytesPerSecond) * 1000) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

/** Decodes 16-bit PCM WAV to mono float samples. */
export function decodeWavPcm16(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
  const info = parseWav(buffer);
  if (info.format !== 1 || info.bitsPerSample !== 16) throw new Error("only 16-bit PCM WAV can be decoded directly");
  const frames = Math.floor(info.dataBytes / (2 * info.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < info.channels; c++) sum += buffer.readInt16LE(info.dataOffset + (i * info.channels + c) * 2);
    samples[i] = sum / info.channels / 32768;
  }
  return { samples, sampleRate: info.sampleRate };
}
