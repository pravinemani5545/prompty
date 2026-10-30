import fs from "node:fs";
import path from "node:path";
import type { Emotion, Platform, SpeechAudio, TurnKind } from "./types.js";

export interface StartEntry {
  type: "start";
  ts: number;
  character: string;
  brain: string;
  voice: string;
}

export interface ExchangeEntry {
  type: "exchange";
  id: string;
  ts: number;
  /** Milliseconds since the session started: use it to find the moment in your VOD. */
  offsetMs: number;
  kind: TurnKind;
  replyTo?: { user: string; platform: Platform; text: string };
  say: string;
  emotion: Emotion;
  audioFile?: string;
  durationMs: number;
  interrupted?: boolean;
}

export interface ClipEntry {
  type: "clip";
  ts: number;
  offsetMs: number;
  exchangeId?: string;
  reason: "manual" | "chat_spike";
}

export interface StarEntry {
  type: "star";
  ts: number;
  exchangeId: string;
}

export interface SkippedEntry {
  type: "skipped";
  ts: number;
  reason: string;
  user?: string;
  text?: string;
}

export type SessionEntry = StartEntry | ExchangeEntry | ClipEntry | StarEntry | SkippedEntry;

export interface SessionExchange extends ExchangeEntry {
  starred: boolean;
  clipped: boolean;
}

/** One stream's worth of logs and audio, in data/sessions/<id>/. */
export class Session {
  private constructor(
    readonly id: string,
    readonly dir: string,
    readonly startedAt: number,
  ) {}

  static create(dataDir: string, now = new Date()): Session {
    const sessionsDir = path.join(dataDir, "sessions");
    let id = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // Two sessions started within the same second (tests, quick restarts) get a suffix.
    for (let n = 2; fs.existsSync(path.join(sessionsDir, id)); n++) id = `${id.slice(0, 19)}_${n}`;
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(path.join(dir, "audio"), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "latest.txt"), id);
    return new Session(id, dir, now.getTime());
  }

  static open(dataDir: string, id = "latest"): Session {
    const sessionsDir = path.join(dataDir, "sessions");
    let resolved = id;
    if (id === "latest") {
      const pointer = path.join(sessionsDir, "latest.txt");
      if (!fs.existsSync(pointer)) throw new Error(`No sessions recorded yet in ${sessionsDir}`);
      resolved = fs.readFileSync(pointer, "utf8").trim();
    }
    const dir = path.join(sessionsDir, resolved);
    if (!/^[\w-]+$/.test(resolved) || !fs.existsSync(dir)) throw new Error(`No session "${resolved}" in ${sessionsDir}`);
    const session = new Session(resolved, dir, 0);
    const start = session.entries().find((e): e is StartEntry => e.type === "start");
    return new Session(resolved, dir, start?.ts ?? fs.statSync(dir).birthtimeMs);
  }

  get audioDir(): string {
    return path.join(this.dir, "audio");
  }

  private get logFile(): string {
    return path.join(this.dir, "session.jsonl");
  }

  saveAudio(name: string, audio: SpeechAudio): string {
    const file = `${name}.${audio.ext}`;
    fs.writeFileSync(path.join(this.audioDir, file), audio.data);
    return file;
  }

  append(entry: SessionEntry): void {
    fs.appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`);
  }

  offset(ts: number): number {
    return Math.max(0, ts - this.startedAt);
  }

  entries(): SessionEntry[] {
    if (!fs.existsSync(this.logFile)) return [];
    return fs
      .readFileSync(this.logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEntry);
  }

  /** Exchanges with their star and clip markers folded in. */
  exchanges(): SessionExchange[] {
    const entries = this.entries();
    const starred = new Set(entries.filter((e): e is StarEntry => e.type === "star").map((e) => e.exchangeId));
    const clipped = new Set(
      entries.filter((e): e is ClipEntry => e.type === "clip" && Boolean(e.exchangeId)).map((e) => e.exchangeId!),
    );
    return entries
      .filter((e): e is ExchangeEntry => e.type === "exchange")
      .map((e) => ({ ...e, starred: starred.has(e.id), clipped: clipped.has(e.id) }));
  }
}
