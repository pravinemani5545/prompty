// Shared types used across the engine, the server and the studio.

export const EMOTIONS = [
  "neutral",
  "happy",
  "excited",
  "smug",
  "surprised",
  "angry",
  "sad",
  "embarrassed",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === "string" && (EMOTIONS as readonly string[]).includes(value);
}

export type Platform = "twitch" | "youtube" | "http" | "console" | "demo";

export type ChatEventKind =
  | "bits"
  | "superchat"
  | "sub"
  | "resub"
  | "giftsub"
  | "member"
  | "raid"
  | "follow";

export interface ChatMessage {
  id: string;
  platform: Platform;
  /** Display name as shown in chat. */
  user: string;
  userId?: string;
  text: string;
  /** Milliseconds since epoch when the message was received. */
  ts: number;
  badges: {
    broadcaster?: boolean;
    mod?: boolean;
    sub?: boolean;
    vip?: boolean;
    member?: boolean;
  };
  firstMessage?: boolean;
  /** Bits, Super Chats and other paid messages. */
  paid?: { amount: number; currency: string; display: string };
  /** Subs, raids, memberships and similar events. */
  event?: ChatEventKind;
  /** The platform's own description of the event, e.g. "X subscribed for 3 months". */
  eventText?: string;
}

/** What the director asks the brain to respond to. */
export type TurnKind = "chat" | "handler" | "event" | "idle";

export interface TurnInput {
  kind: TurnKind;
  text: string;
  message?: ChatMessage;
}

/** A finished exchange: what Crumb said and what it was replying to. */
export interface Exchange {
  id: string;
  kind: TurnKind;
  ts: number;
  replyTo?: { user: string; platform: Platform; text: string };
  say: string;
  emotion: Emotion;
}

export interface Reply {
  emotion: Emotion;
  say: string;
  /** Optional short fact the brain wants remembered (about the viewer, or a new running bit). */
  remember?: string;
}

export interface SpeechAudio {
  data: Buffer;
  ext: "mp3" | "wav";
  mime: string;
  durationMs: number;
}
