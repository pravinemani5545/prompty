import type { ChatMessage } from "../types.js";
import { messageId, type ChatSource, type SourceState } from "./source.js";

const USERS = ["breadwinner_99", "pixelpanda", "CodeGoblin", "sourdough_sam", "NightOwlDev", "toastmaster_flex", "lofi_luna", "rustacean_rex"];

const LINES = [
  "Crumb roast my setup, I have three monitors and one chair leg",
  "what do you think of tabs vs spaces?",
  "hi crumb!! first time here",
  "rate my startup idea: uber for toasters",
  "crumb are you smarter than the microwave?",
  "my code compiled on the first try, rate that",
  "what's your favorite bread",
  "roast my 47 open chrome tabs",
  "is it true you've never toasted bread?",
  "LETS GOOO",
  "crumb what is your firmware version now?",
  "rate my hot take: dark mode is overrated",
];

/** A fake audience for demos and rehearsals: no platform account needed. */
export class DemoChat implements ChatSource {
  readonly name = "demo audience";
  private currentState: SourceState = "idle";
  private timer: NodeJS.Timeout | undefined;
  private sent = 0;

  constructor(private readonly options: { minDelayMs?: number; maxDelayMs?: number; random?: () => number } = {}) {}

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
        text: LINES[Math.floor(random() * LINES.length)]!,
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
