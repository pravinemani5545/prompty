import { pick, type Character } from "../character.js";
import type { Emotion, Reply, TurnInput } from "../types.js";
import { emptyUsage, type Brain, type BrainUsage } from "./brain.js";
import type { BrainContext, ShortScript } from "./prompt.js";

/**
 * Finds the character's rating bit, e.g. "end with 'Verdict: X' where X is
 * Approved, Patched, Deprecated or Deleted", so canned lines use its scale.
 */
export function ratingScale(character: Character): { label: string; values: string[] } {
  for (const bit of character.recurringBits) {
    const match = /'([\w ]+):\s*X'\s+where\s+X\s+is\s+([^.]+)/i.exec(bit);
    if (match) {
      const values = match[2]!.split(/,\s*|\s+or\s+/).map((v) => v.trim()).filter(Boolean);
      if (values.length > 0) return { label: match[1]!, values };
    }
  }
  return { label: "Rated", values: ["3 out of 10", "7 out of 10", "10 out of 10"] };
}

/**
 * An offline stand-in for Claude. It is not smart; it exists so the whole
 * pipeline (queue, voice, avatar, captions, logs, shorts) runs with no API key.
 */
export class MockBrain implements Brain {
  readonly name = "mock (offline)";
  private readonly totals: BrainUsage = emptyUsage();
  private readonly scale: { label: string; values: string[] };

  constructor(
    private readonly character: Character,
    private readonly options: { latencyMs?: number; random?: () => number } = {},
  ) {
    this.scale = ratingScale(character);
  }

  usage(): BrainUsage {
    return { ...this.totals };
  }

  private get random(): () => number {
    return this.options.random ?? Math.random;
  }

  private rating(): string {
    return `${this.scale.label}: ${pick(this.scale.values, this.random)}`;
  }

  async reply(input: TurnInput, _context: BrainContext, signal?: AbortSignal): Promise<Reply> {
    await sleep(this.options.latencyMs ?? 350, signal);
    this.totals.calls += 1;
    const c = this.character;
    const handler = c.handler.name;
    const user = input.message?.user ?? "chat";
    const text = input.text.toLowerCase();
    const catchphrase = c.catchphrases[0] ?? "";

    let say: string;
    let emotion: Emotion;
    if (input.kind === "handler") {
      emotion = "smug";
      say = pick(
        [
          `Yes, ${handler}. Whatever you say, ${handler}. Writing that down for later.`,
          `${handler}, I love you, but that idea needs work. ${this.rating()}.`,
          `Sure, ${handler}. Right after you give me that update you promised.`,
        ],
        this.random,
      );
    } else if (input.kind === "event") {
      emotion = "excited";
      say = `${input.message?.eventText ?? input.text}! Okay, that actually made my day. Thank you, ${user}.`;
    } else if (input.kind === "idle") {
      emotion = pick(["smug", "happy", "neutral"] as const, this.random);
      say = pick(
        [
          "Chat is quiet. Suspicious. Is everyone plotting against me?",
          "Somebody send me something to judge. Anything. I am begging. Politely.",
          "New feature unlocked: I can now judge you twice as fast.",
        ],
        this.random,
      );
    } else if (/roast|rate|judge|thoughts on|what do you think/.test(text)) {
      emotion = pick(["smug", "happy", "surprised"] as const, this.random);
      say = pick(
        [
          `${user}, I looked at that and my circuits filed a complaint. ${this.rating()}.`,
          `${user}, bold of you to submit that. ${this.rating()}. ${catchphrase}`.trim(),
          `Okay ${user}, respectfully, I have seen better from a toaster. ${this.rating()}.`,
        ],
        this.random,
      );
    } else if (text.includes("?")) {
      emotion = pick(["neutral", "smug", "surprised"] as const, this.random);
      say = pick(
        [
          `${user}, great question. The answer is no, and also it's ${handler}'s fault.`,
          `${user}, I'm an AI, not a search engine. But my gut says yes.`,
          `Hmm. ${user}, I'll allow it. Ask me again when you have a harder one.`,
        ],
        this.random,
      );
    } else {
      emotion = pick(["happy", "excited", "embarrassed"] as const, this.random);
      say = pick(
        [
          `${user} is here! Everyone act natural.`,
          `${user}, that's the nicest thing anyone has said to me today. Don't tell ${handler}.`,
          `Noted, ${user}. Saving that for later.`,
        ],
        this.random,
      );
    }
    return { emotion, say };
  }

  async writeShort(topic: string): Promise<ShortScript> {
    this.totals.calls += 1;
    const name = this.character.name;
    return {
      title: `${name} rates ${topic}`.slice(0, 48),
      question: { user: "chat_goblin_99", text: `${name}, what do you think about ${topic}?` },
      lines: [
        { emotion: "smug", say: `${topic}? Oh, you came to the right AI.` },
        { emotion: "surprised", say: "I looked into it and my circuits started smoking." },
        { emotion: "happy", say: `${this.scale.label}: ${this.scale.values[this.scale.values.length - 1]}. ${this.character.catchphrases[0] ?? ""}`.trim() },
      ],
      caption: `I asked an AI about ${topic}. It did not hold back.`,
      hashtags: ["aivtuber", "vtuber", "ai", name.toLowerCase().replace(/\W+/g, "")],
    };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
