import { pick, type Character } from "../character.js";
import type { Emotion, Reply, TurnInput } from "../types.js";
import { emptyUsage, type Brain, type BrainUsage } from "./brain.js";
import type { BrainContext, ShortScript } from "./prompt.js";

const RATINGS = ["Raw", "Golden", "Golden", "Toasted", "Toasted", "Burnt", "Charcoal"] as const;

/**
 * An offline stand-in for Claude. It is not smart; it exists so the whole
 * pipeline (queue, voice, avatar, captions, logs, shorts) runs with no API key.
 */
export class MockBrain implements Brain {
  readonly name = "mock (offline)";
  private readonly totals: BrainUsage = emptyUsage();

  constructor(
    private readonly character: Character,
    private readonly options: { latencyMs?: number; random?: () => number } = {},
  ) {}

  usage(): BrainUsage {
    return { ...this.totals };
  }

  private get random(): () => number {
    return this.options.random ?? Math.random;
  }

  async reply(input: TurnInput, _context: BrainContext, signal?: AbortSignal): Promise<Reply> {
    await sleep(this.options.latencyMs ?? 350, signal);
    this.totals.calls += 1;
    const c = this.character;
    const user = input.message?.user ?? "chat";
    const text = input.text.toLowerCase();
    const rating = pick(RATINGS, this.random);

    let say: string;
    let emotion: Emotion;
    if (input.kind === "handler") {
      emotion = "smug";
      say = pick(
        [
          `Yes, ${c.handler.name}. Whatever you say, ${c.handler.name}. Writing that down in my crumb tray.`,
          `${c.handler.name}, I love you, but that idea is room temperature. Rated: ${rating}.`,
          `Sure, ${c.handler.name}. Right after you update my firmware like you promised.`,
        ],
        this.random,
      );
    } else if (input.kind === "event") {
      emotion = "excited";
      say = `${input.message?.eventText ?? input.text}! Okay, that one actually warmed my coils. Thank you, ${user}.`;
    } else if (input.kind === "idle") {
      emotion = pick(["smug", "happy", "neutral"] as const, this.random);
      say = pick(
        [
          "Chat is quiet. Suspicious. Did the Microwave pay you all off?",
          "Somebody put something in my slots. A setup, a hot take, anything. I am begging. Politely.",
          `Firmware update incoming. New feature: I can now judge you twice as fast.`,
        ],
        this.random,
      );
    } else if (/roast|rate|judge|thoughts on|what do you think/.test(text)) {
      emotion = rating === "Charcoal" || rating === "Burnt" ? "smug" : "happy";
      say = pick(
        [
          `${user}, I looked at that and my heating coils filed a complaint. Rated: ${rating}.`,
          `${user}, bold of you to put that in my slot. Rated: ${rating}. Ding! You're done.`,
          `Okay ${user}, respectfully, the Microwave could have done better. Rated: ${rating}.`,
        ],
        this.random,
      );
    } else if (text.includes("?")) {
      emotion = pick(["neutral", "smug", "surprised"] as const, this.random);
      say = pick(
        [
          `${user}, great question. The answer is no, and also the Microwave did it.`,
          `${user}, I'm a toaster, not a search engine. But my gut says yes. My gut is a heating coil.`,
          `Hmm. ${user}, I'll allow it. Ask me again when you have a harder one.`,
        ],
        this.random,
      );
    } else {
      emotion = pick(["happy", "excited", "embarrassed"] as const, this.random);
      say = pick(
        [
          `${user} is here! Everyone act natural. Especially you, Microwave.`,
          `${user}, that's the warmest thing anyone has said to me today. Don't tell Dev.`,
          `Noted, ${user}. Filing that in the crumb tray for later.`,
        ],
        this.random,
      );
    }
    return { emotion, say };
  }

  async writeShort(topic: string): Promise<ShortScript> {
    this.totals.calls += 1;
    return {
      title: `An AI toaster rates ${topic}`.slice(0, 48),
      question: { user: "breadwinner_99", text: `Crumb, what do you think about ${topic}?` },
      lines: [
        { emotion: "smug", say: `${topic}? Oh, you came to the right appliance.` },
        { emotion: "surprised", say: "I put it in my slot and the smoke alarm started clapping." },
        { emotion: "happy", say: "Rated: Burnt. Ding! You're done." },
      ],
      caption: `I asked an AI toaster about ${topic}. It did not hold back.`,
      hashtags: ["aivtuber", "vtuber", "roast", "ai"],
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
