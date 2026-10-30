import type { ChatMessage } from "../types.js";

export type SourceState = "idle" | "connecting" | "connected" | "error" | "stopped";

export interface ChatSource {
  readonly name: string;
  readonly state: SourceState;
  start(onMessage: (message: ChatMessage) => void): void;
  stop(): void;
}

let counter = 0;
export function messageId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
