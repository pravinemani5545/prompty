import type { ChatMessage } from "../types.js";
import { messageId, type ChatSource, type SourceState } from "./source.js";

const USERS = ["breadwinner_99", "pixelpanda", "CodeGoblin", "sourdough_sam", "NightOwlDev", "toastmaster_flex", "lofi_luna", "rustacean_rex"];

// {name} is replaced with the character's name.
const LINES = [
  "{name} roast my setup, I have three monitors and one chair leg",
  "what do you think of tabs vs spaces?",
  "hi {name}!! first time here",
  "rate my startup idea: uber for houseplants",
  "{name} are you smarter than a smart speaker?",
  "my code compiled on the first try, rate that",
  "what's your favorite snack",
  "roast my 47 open chrome tabs",
  "{name} judge my desk setup pls",
  "LETS GOOO",
  "{name} what did you learn today?",
  "rate my hot take: dark mode is overrated",
];

/** A fake audience for demos and rehearsals: no platform account needed. */
export class DemoChat implements ChatSource {
  readonly name = "demo audience";
  private currentState: SourceState = "idle";
  private timer: NodeJS.Timeout | undefined;
  private sent = 0;

  constructor(
    private readonly options: { characterName?: string; minDelayMs?: number; maxDelayMs?: number; random?: () => number } = {},
  ) {}

  get state(): SourceState {
    return this.currentState;
  }

  start(onMessage: (message: ChatMessage) => void): void {
    const random = this.options.random ?? Math.random;
    const min = this.options.minDelayMs ?? 4000;
    const max = this.options.maxDelayMs ?? 9000;
    this.currentState = "connected";
    const tick = () => {
      const user = USERS[Math.floor(random() * USERS.length)]!;
      this.sent += 1;
      const base: ChatMessage = {
        id: messageId("demo"),
        platform: "demo",
        user,
        text: LINES[Math.floor(random() * LINES.length)]!.replace("{name}", (this.options.characterName ?? "bot").toLowerCase()),
        ts: Date.now(),
        badges: { sub: random() < 0.3 },
        firstMessage: this.sent <= 2,
      };
      if (this.sent % 9 === 0) {
        onMessage({ ...base, text: "", event: "sub", eventText: `${user} subscribed for ${1 + Math.floor(random() * 12)} months` });
      } else if (this.sent % 13 === 0) {
        onMessage({ ...base, paid: { amount: 5, currency: "USD", display: "500 bits" }, event: "bits", eventText: `${user} cheered 500 bits` });
      } else {
        onMessage(base);
      }
      this.timer = setTimeout(tick, min + random() * (max - min));
    };
    this.timer = setTimeout(tick, 1500);
  }

  stop(): void {
    this.currentState = "stopped";
    clearTimeout(this.timer);
  }
}
