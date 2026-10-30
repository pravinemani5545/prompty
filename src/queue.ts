import type { ChatMessage } from "./types.js";

export interface QueueOptions {
  characterName: string;
  /** Unpaid messages older than this are dropped: answering stale chat feels broken. */
  maxAgeMs: number;
  /** Paid messages and events wait longer before they are dropped. */
  maxPriorityAgeMs: number;
  maxSize: number;
  /** Penalize users who were answered within this window so one person can't hog the show. */
  cooldownMs: number;
}

export const DEFAULT_QUEUE_OPTIONS: Omit<QueueOptions, "characterName"> = {
  maxAgeMs: 45_000,
  maxPriorityAgeMs: 5 * 60_000,
  maxSize: 200,
  cooldownMs: 60_000,
};

interface Entry {
  message: ChatMessage;
  base: number;
  priority: boolean;
}

/** Base score for a message, before age and cooldown adjustments. */
export function scoreMessage(message: ChatMessage, characterName: string, isRegular: boolean): number {
  let score = 0;
  if (message.paid) score += 1000 + Math.min(message.paid.amount, 500);
  if (message.event && !message.paid) score += 800;
  const text = message.text.trim();
  if (text.toLowerCase().includes(characterName.toLowerCase())) score += 120;
  if (text.includes("?")) score += 60;
  if (message.firstMessage) score += 50;
  if (message.badges.mod || message.badges.broadcaster) score += 30;
  if (message.badges.sub || message.badges.member) score += 25;
  if (isRegular) score += 25;
  if (text.length >= 15 && text.length <= 200) score += 20;
  if (text.length < 4 && !message.event) score -= 80;
  return score;
}

/** Holds incoming chat and picks the most worthwhile message to answer next. */
export class ChatQueue {
  private entries: Entry[] = [];
  private readonly lastReplied = new Map<string, number>();
  private readonly options: QueueOptions;

  constructor(options: Partial<QueueOptions> & { characterName: string }) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };
  }

  private static userKey(message: ChatMessage): string {
    return `${message.platform}:${message.user.toLowerCase()}`;
  }

  push(message: ChatMessage, isRegular = false): void {
    this.entries.push({
      message,
      base: scoreMessage(message, this.options.characterName, isRegular),
      priority: Boolean(message.paid || message.event),
    });
    if (this.entries.length > this.options.maxSize) {
      // Drop the lowest-scoring unpaid entry to make room.
      const now = Date.now();
      let worst = -1;
      let worstScore = Infinity;
      this.entries.forEach((entry, index) => {
        const score = this.effectiveScore(entry, now);
        if (!entry.priority && score < worstScore) {
          worst = index;
          worstScore = score;
        }
      });
      this.entries.splice(worst >= 0 ? worst : 0, 1);
    }
  }

  private effectiveScore(entry: Entry, now: number): number {
    const ageSeconds = (now - entry.message.ts) / 1000;
    let score = entry.base - ageSeconds * 2;
    const replied = this.lastReplied.get(ChatQueue.userKey(entry.message));
    if (replied !== undefined && now - replied < this.options.cooldownMs) score -= 300;
    return score;
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((entry) => {
      const age = now - entry.message.ts;
      return age <= (entry.priority ? this.options.maxPriorityAgeMs : this.options.maxAgeMs);
    });
  }

  /** Removes and returns the best message to answer, if any. */
  next(now = Date.now()): ChatMessage | undefined {
    this.prune(now);
    if (this.entries.length === 0) return undefined;
    let best = 0;
    let bestScore = -Infinity;
    this.entries.forEach((entry, index) => {
      const score = this.effectiveScore(entry, now);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    const [entry] = this.entries.splice(best, 1);
    return entry?.message;
  }

  markReplied(message: ChatMessage, now = Date.now()): void {
    this.lastReplied.set(ChatQueue.userKey(message), now);
  }

  get size(): number {
    return this.entries.length;
  }

  /** Current queue in pick order, for the operator console. */
  snapshot(now = Date.now()): { message: ChatMessage; score: number }[] {
    this.prune(now);
    return this.entries
      .map((entry) => ({ message: entry.message, score: Math.round(this.effectiveScore(entry, now)) }))
      .sort((a, b) => b.score - a.score);
  }
}
