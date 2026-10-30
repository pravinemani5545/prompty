import type { Reply, TurnInput } from "../types.js";
import type { BrainContext, ShortScript } from "./prompt.js";

export interface BrainUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Rough spend estimate from list prices. Check your Anthropic console for real numbers. */
  estimatedUsd: number;
}

export interface Brain {
  readonly name: string;
  reply(input: TurnInput, context: BrainContext, signal?: AbortSignal): Promise<Reply>;
  writeShort(topic: string): Promise<ShortScript>;
  usage(): BrainUsage;
}

export function emptyUsage(): BrainUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 };
}

/**
 * Sends requests to the primary brain until its estimated spend reaches the
 * budget, then switches to the fallback (the offline mock) for the rest of the run.
 */
export class BudgetedBrain implements Brain {
  readonly name: string;
  private exhausted = false;

  constructor(
    private readonly primary: Brain,
    private readonly fallback: Brain,
    private readonly budgetUsd: number,
    private readonly onExhausted: (spentUsd: number) => void = () => {},
  ) {
    this.name = primary.name;
  }

  private active(): Brain {
    if (this.budgetUsd <= 0 || this.exhausted) return this.exhausted ? this.fallback : this.primary;
    const spent = this.primary.usage().estimatedUsd;
    if (spent >= this.budgetUsd) {
      this.exhausted = true;
      this.onExhausted(spent);
      return this.fallback;
    }
    return this.primary;
  }

  reply(input: TurnInput, context: BrainContext, signal?: AbortSignal): Promise<Reply> {
    return this.active().reply(input, context, signal);
  }

  writeShort(topic: string): Promise<ShortScript> {
    return this.active().writeShort(topic);
  }

  usage(): BrainUsage {
    return this.primary.usage();
  }

  get budgetExhausted(): boolean {
    return this.exhausted;
  }
}
