import { EventEmitter } from "node:events";
import type { Brain, BrainUsage } from "./brain/brain.js";
import type { BrainContext } from "./brain/prompt.js";
import { pick, type Character } from "./character.js";
import { createLogger, errorMessage } from "./log.js";
import type { Memory } from "./memory.js";
import { ChatQueue } from "./queue.js";
import type { InputVerdict, Safety } from "./safety.js";
import type { ExchangeEntry, Session } from "./session.js";
import type { ChatMessage, Emotion, Exchange, Platform, Reply, SpeechAudio, TurnInput } from "./types.js";
import { silentDurationMs, type Voice } from "./voice/voices.js";

const log = createLogger("director");

export interface DirectorTiming {
  /** Breathing room between turns. */
  minGapMs: number;
  /** Silence before the character starts idle chatter. */
  idleAfterMs: number;
  /** Extra wait past the audio length before assuming playback finished. */
  playbackGraceMs: number;
  /** How long a reply waits for approval in review mode before it is dropped. */
  reviewTimeoutMs: number;
  /** How many recent exchanges the brain sees. */
  recentExchanges: number;
}

const DEFAULT_TIMING: DirectorTiming = {
  minGapMs: 600,
  idleAfterMs: 30_000,
  playbackGraceMs: 2500,
  reviewTimeoutMs: 90_000,
  recentExchanges: 6,
};

export type DirectorPhase = "idle" | "thinking" | "reviewing" | "speaking";

export interface Utterance {
  id: string;
  text: string;
  emotion: Emotion;
  /** Null when TTS is off; the avatar mouths along silently for `durationMs`. */
  audioUrl: string | null;
  durationMs: number;
  replyTo?: { user: string; platform: Platform; text: string };
}

export interface DirectorStatus {
  phase: DirectorPhase;
  paused: boolean;
  idleChatter: boolean;
  reviewMode: boolean;
  brain: string;
  voice: string;
  usage: BrainUsage;
  session: string;
  queue: { user: string; platform: Platform; text: string; score: number; paid?: string; event?: string }[];
  lastExchangeId: string | null;
}

export interface DirectorDeps {
  character: Character;
  brain: Brain;
  voice: Voice | null;
  safety: Safety;
  memory: Memory;
  session: Session;
  reviewMode?: boolean;
  idleChatter?: boolean;
  timing?: Partial<DirectorTiming>;
}

interface PlannedTurn {
  input: TurnInput;
  /** Operator-written lines skip the brain and safety review. */
  direct?: Reply;
}

type PlaybackResult = "ended" | "timeout" | "aborted";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The show runner. Takes chat in, decides what to answer, asks the brain,
 * screens the reply, voices it, hands it to the avatar and logs it.
 *
 * Events: speak, stop, thinking, emotion, chat, pending, exchange, clip, star, alert, state.
 */
export class Director extends EventEmitter {
  private readonly timing: DirectorTiming;
  private readonly queue: ChatQueue;
  private readonly operatorTurns: PlannedTurn[] = [];
  private readonly recent: Exchange[] = [];
  private readonly playbackWaiters = new Map<string, () => void>();
  private readonly reviewWaiters = new Map<string, (approved: boolean) => void>();
  private readonly chatTimes: number[] = [];
  private running = false;
  private paused = false;
  private idleChatter: boolean;
  private reviewMode: boolean;
  private phase: DirectorPhase = "idle";
  private lastActivity = Date.now();
  private lastIdleAt = 0;
  private lastSpikeAt = 0;
  private turnAbort: AbortController | null = null;
  private loopDone: Promise<void> | null = null;
  private counter = 0;
  private currentExchangeId: string | null = null;
  private lastExchangeId: string | null = null;

  constructor(private readonly deps: DirectorDeps) {
    super();
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.queue = new ChatQueue({ characterName: deps.character.name });
    this.reviewMode = deps.reviewMode ?? false;
    this.idleChatter = deps.idleChatter ?? true;
  }

  // ---- inputs -------------------------------------------------------------

  ingest(message: ChatMessage): void {
    const { memory, safety, session } = this.deps;
    this.lastActivity = Date.now();
    this.detectChatSpike(message.ts);
    memory.touch(message.platform, message.user);

    const verdict: InputVerdict = message.text.trim() ? safety.screenInput(message.text) : { ok: true };
    this.emit("chat", { message, verdict });
    if (!verdict.ok) {
      session.append({ type: "skipped", ts: Date.now(), reason: verdict.reason, user: message.user, text: message.text });
      if (verdict.alert) {
        log.warn(`ALERT (${verdict.reason}) from ${message.user}: a human should check on this viewer`);
        this.emit("alert", { message, reason: verdict.reason });
      }
      // Still thank people for paid support, just without reading their text out.
      if (message.paid || message.event) this.queue.push({ ...message, text: "" });
      this.emitState();
      return;
    }
    this.queue.push(message, memory.isRegular(message.platform, message.user));
    this.emitState();
  }

  /** The handler talking to the character (typed or push-to-talk in the console). */
  handler(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.operatorTurns.push({ input: { kind: "handler", text: clean } });
    this.lastActivity = Date.now();
    this.emitState();
  }

  /** Makes the character say an exact line, skipping the brain. */
  say(text: string, emotion: Emotion = "neutral"): void {
    const clean = text.trim();
    if (!clean) return;
    this.operatorTurns.push({ input: { kind: "handler", text: clean }, direct: { emotion, say: clean } });
    this.emitState();
  }

  /** Called by the avatar page when it finishes playing an utterance. */
  playbackEnded(id: string): void {
    this.playbackWaiters.get(id)?.();
  }

  // ---- operator controls --------------------------------------------------

  pause(): void {
    this.paused = true;
    this.skip();
    log.info("paused");
    this.emitState();
  }

  resume(): void {
    this.paused = false;
    this.lastActivity = Date.now();
    log.info("resumed");
    this.emitState();
  }

  /** Abandons whatever is happening right now: thinking, waiting for review, or speaking. */
  skip(): void {
    this.turnAbort?.abort(new Error("skipped"));
    this.emit("stop");
  }

  setIdleChatter(on: boolean): void {
    this.idleChatter = on;
    this.emitState();
  }

  setReviewMode(on: boolean): void {
    this.reviewMode = on;
    if (!on) for (const resolve of this.reviewWaiters.values()) resolve(true);
    this.emitState();
  }

  approve(id: string): void {
    this.reviewWaiters.get(id)?.(true);
  }

  reject(id: string): void {
    this.reviewWaiters.get(id)?.(false);
  }

  setEmotion(emotion: Emotion): void {
    this.emit("emotion", emotion);
  }

  markClip(reason: "manual" | "chat_spike" = "manual"): void {
    const now = Date.now();
    const exchangeId = this.currentExchangeId ?? this.lastExchangeId ?? undefined;
    this.deps.session.append({ type: "clip", ts: now, offsetMs: this.deps.session.offset(now), exchangeId, reason });
    log.info(`clip marked (${reason}) at ${formatOffset(this.deps.session.offset(now))}`);
    this.emit("clip", { exchangeId, reason, offsetMs: this.deps.session.offset(now) });
  }

  star(exchangeId: string): void {
    this.deps.session.append({ type: "star", ts: Date.now(), exchangeId });
    this.emit("star", exchangeId);
  }

  status(): DirectorStatus {
    return {
      phase: this.phase,
      paused: this.paused,
      idleChatter: this.idleChatter,
      reviewMode: this.reviewMode,
      brain: this.deps.brain.name,
      voice: this.deps.voice?.name ?? "none (silent)",
      usage: this.deps.brain.usage(),
      session: this.deps.session.id,
      queue: this.queue.snapshot().slice(0, 12).map(({ message, score }) => ({
        user: message.user,
        platform: message.platform,
        text: message.text,
        score,
        paid: message.paid?.display,
        event: message.event,
      })),
      lastExchangeId: this.lastExchangeId,
    };
  }

  // ---- the loop -----------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.session.append({
      type: "start",
      ts: this.deps.session.startedAt,
      character: this.deps.character.name,
      brain: this.deps.brain.name,
      voice: this.deps.voice?.name ?? "none",
    });
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.skip();
    await this.loopDone;
    this.deps.memory.flush();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.paused) {
        await sleep(150);
        continue;
      }
      const turn = this.nextTurn();
      if (!turn) {
        await sleep(120);
        continue;
      }
      try {
        await this.runTurn(turn);
      } catch (error) {
        log.error(`turn failed: ${errorMessage(error)}`);
      } finally {
        this.turnAbort = null;
        this.currentExchangeId = null;
        this.setPhase("idle");
      }
      if (this.running) await sleep(this.timing.minGapMs);
    }
  }

  private nextTurn(): PlannedTurn | undefined {
    const operator = this.operatorTurns.shift();
    if (operator) return operator;

    const message = this.queue.next();
    if (message) {
      if (message.event && !message.text.trim()) {
        return { input: { kind: "event", text: message.eventText ?? `${message.user}: ${message.event}`, message } };
      }
      return { input: { kind: "chat", text: message.text, message } };
    }

    const now = Date.now();
    const topics = this.deps.character.idleTopics;
    if (
      this.idleChatter &&
      topics.length > 0 &&
      now - this.lastActivity >= this.timing.idleAfterMs &&
      now - this.lastIdleAt >= this.timing.idleAfterMs
    ) {
      this.lastIdleAt = now;
      return { input: { kind: "idle", text: pick(topics) } };
    }
    return undefined;
  }

  private contextFor(input: TurnInput): BrainContext {
    const message = input.message;
    return {
      recent: this.recent.slice(-this.timing.recentExchanges),
      viewerNotes: message ? this.deps.memory.notesFor(message.platform, message.user) : [],
      lore: this.deps.memory.lore(),
    };
  }

  private async runTurn(turn: PlannedTurn): Promise<void> {
    const { brain, character, safety, session, voice, memory } = this.deps;
    const abort = new AbortController();
    this.turnAbort = abort;
    const { input } = turn;

    let reply: Reply;
    if (turn.direct) {
      reply = turn.direct;
    } else {
      this.setPhase("thinking");
      this.emit("thinking", true);
      try {
        reply = await brain.reply(input, this.contextFor(input), abort.signal);
      } catch (error) {
        if (abort.signal.aborted) return;
        log.warn(`brain failed, using a fallback line: ${errorMessage(error)}`);
        reply = { emotion: "embarrassed", say: pick(character.fallbackLines) };
      } finally {
        this.emit("thinking", false);
      }
      const screened = safety.screenOutput(reply.say);
      if (screened.ok) {
        reply = { ...reply, say: screened.text };
      } else {
        log.warn(`reply blocked (${screened.reason}): ${reply.say}`);
        session.append({ type: "skipped", ts: Date.now(), reason: `output:${screened.reason}`, text: reply.say });
        reply = { emotion: "neutral", say: pick(character.fallbackLines) };
      }
    }
    if (abort.signal.aborted) return;

    const id = this.nextId();
    const message = input.message;
    const replyTo = message ? { user: message.user, platform: message.platform, text: message.text || (message.eventText ?? "") } : undefined;

    if (this.reviewMode && !turn.direct) {
      this.setPhase("reviewing");
      const approved = await this.awaitReview({ id, text: reply.say, emotion: reply.emotion, audioUrl: null, durationMs: 0, replyTo }, abort.signal);
      if (!approved) {
        session.append({ type: "skipped", ts: Date.now(), reason: "rejected_in_review", text: reply.say });
        return;
      }
    }

    let audio: SpeechAudio | null = null;
    if (voice) {
      try {
        audio = await voice.synthesize(reply.say, reply.emotion);
      } catch (error) {
        log.warn(`voice failed, speaking silently: ${errorMessage(error)}`);
      }
    }
    if (abort.signal.aborted) return;

    const audioFile = audio ? session.saveAudio(id, audio) : undefined;
    const durationMs = audio?.durationMs ?? silentDurationMs(reply.say);
    const utterance: Utterance = {
      id,
      text: reply.say,
      emotion: reply.emotion,
      audioUrl: audioFile ? `/media/${session.id}/${audioFile}` : null,
      durationMs,
      replyTo,
    };

    const startedAt = Date.now();
    this.currentExchangeId = id;
    this.setPhase("speaking");
    this.emit("speak", utterance);
    const result = await this.awaitPlayback(id, durationMs, abort.signal);

    const entry: ExchangeEntry = {
      type: "exchange",
      id,
      ts: startedAt,
      offsetMs: session.offset(startedAt),
      kind: input.kind,
      replyTo,
      say: reply.say,
      emotion: reply.emotion,
      audioFile,
      durationMs,
      ...(result === "aborted" ? { interrupted: true } : {}),
    };
    session.append(entry);
    this.recent.push({ id, kind: input.kind, ts: startedAt, replyTo, say: reply.say, emotion: reply.emotion });
    if (this.recent.length > 50) this.recent.splice(0, this.recent.length - 50);
    if (message && input.kind === "chat") {
      this.queue.markReplied(message);
      memory.recordReply(message.platform, message.user);
    }
    if (reply.remember) {
      memory.remember(reply.remember, message && input.kind === "chat" ? { platform: message.platform, user: message.user } : undefined);
    }
    this.lastActivity = Date.now();
    this.lastExchangeId = id;
    this.emit("exchange", entry);
  }

  private awaitPlayback(id: string, durationMs: number, signal: AbortSignal): Promise<PlaybackResult> {
    return new Promise((resolve) => {
      const finish = (result: PlaybackResult) => {
        clearTimeout(timer);
        this.playbackWaiters.delete(id);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), durationMs + this.timing.playbackGraceMs);
      this.playbackWaiters.set(id, () => finish("ended"));
      if (signal.aborted) return finish("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private awaitReview(utterance: Utterance, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (approved: boolean) => {
        clearTimeout(timer);
        this.reviewWaiters.delete(utterance.id);
        signal.removeEventListener("abort", onAbort);
        this.emit("reviewed", { id: utterance.id, approved });
        resolve(approved);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), this.timing.reviewTimeoutMs);
      this.reviewWaiters.set(utterance.id, finish);
      if (signal.aborted) return finish(false);
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit("pending", utterance);
    });
  }

  /** Marks a clip when chat suddenly gets much busier than usual. */
  private detectChatSpike(ts: number): void {
    this.chatTimes.push(ts);
    const cutoff = ts - 60_000;
    while (this.chatTimes.length > 0 && this.chatTimes[0]! < cutoff) this.chatTimes.shift();
    const last15 = this.chatTimes.filter((t) => t >= ts - 15_000).length;
    const earlier = this.chatTimes.length - last15;
    const usualPer15 = earlier / 3;
    if (last15 >= Math.max(6, usualPer15 * 3) && ts - this.lastSpikeAt > 30_000) {
      this.lastSpikeAt = ts;
      this.markClip("chat_spike");
    }
  }

  private nextId(): string {
    this.counter += 1;
    return `x${String(this.counter).padStart(4, "0")}`;
  }

  private setPhase(phase: DirectorPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emitState();
  }

  private emitState(): void {
    this.emit("state", this.status());
  }
}

export function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
