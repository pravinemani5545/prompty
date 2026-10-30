import Anthropic from "@anthropic-ai/sdk";
import type { Character } from "../character.js";
import type { Effort } from "../config.js";
import type { Reply, TurnInput } from "../types.js";
import { emptyUsage, type Brain, type BrainUsage } from "./brain.js";
import {
  REPLY_SCHEMA,
  SHORT_SCHEMA,
  buildShortPrompt,
  buildSystemPrompt,
  buildTurnMessage,
  parseReply,
  parseShortScript,
  type BrainContext,
  type ShortScript,
} from "./prompt.js";

/** USD per million tokens, used only for the on-screen spend estimate. */
const PRICES: { prefix: string; input: number; output: number; cacheRead: number; cacheWrite: number }[] = [
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { prefix: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { prefix: "claude-haiku-5-5", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
];
const DEFAULT_PRICE = PRICES[0]!;

export class BrainRefusal extends Error {
  constructor(readonly category: string | null) {
    super(`Claude declined to answer${category ? ` (${category})` : ""}`);
  }
}

export interface ClaudeBrainOptions {
  model: string;
  effortLive: Effort;
  effortScripts: Effort;
  client?: Anthropic;
}

export class ClaudeBrain implements Brain {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly systemPrompt: string;
  private readonly totals: BrainUsage = emptyUsage();

  constructor(
    private readonly character: Character,
    private readonly options: ClaudeBrainOptions,
  ) {
    this.client = options.client ?? new Anthropic();
    this.systemPrompt = buildSystemPrompt(character);
    this.name = `claude (${options.model})`;
  }

  usage(): BrainUsage {
    return { ...this.totals };
  }

  async reply(input: TurnInput, context: BrainContext, signal?: AbortSignal): Promise<Reply> {
    const response = await this.client.beta.messages.create(
      {
        ...this.requestBase(),
        // Thinking counts toward max_tokens, so leave headroom beyond the short reply.
        max_tokens: 4096,
        messages: [{ role: "user", content: buildTurnMessage(input, context, this.character) }],
        output_config: { effort: this.options.effortLive, format: { type: "json_schema", schema: REPLY_SCHEMA } },
      },
      { signal, timeout: 45_000, maxRetries: 1 },
    );
    this.track(response.usage);
    const reply = parseReply(this.textOf(response));
    if (!reply) throw new Error(`Claude returned no usable reply (stop_reason: ${response.stop_reason})`);
    return reply;
  }

  async writeShort(topic: string): Promise<ShortScript> {
    const stream = this.client.beta.messages.stream({
      ...this.requestBase(),
      max_tokens: 16000,
      messages: [{ role: "user", content: buildShortPrompt(topic, this.character) }],
      output_config: { effort: this.options.effortScripts, format: { type: "json_schema", schema: SHORT_SCHEMA } },
    });
    const response = await stream.finalMessage();
    this.track(response.usage);
    const script = parseShortScript(this.textOf(response));
    if (!script) throw new Error(`Claude returned no usable script (stop_reason: ${response.stop_reason})`);
    return script;
  }

  /** The cache-stable part of every request: model, persona prompt and refusal fallback. */
  private requestBase() {
    // Haiku has no server-side fallback model, so the parameter is only sent for the others.
    const fallback = this.options.model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
    return {
      model: this.options.model,
      ...fallback,
      system: [{ type: "text" as const, text: this.systemPrompt, cache_control: { type: "ephemeral" as const } }],
    };
  }

  private textOf(response: Anthropic.Beta.Messages.BetaMessage): string {
    if (response.stop_reason === "refusal") {
      throw new BrainRefusal(response.stop_details?.category ?? null);
    }
    return response.content
      .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  private track(usage: Anthropic.Beta.Messages.BetaUsage): void {
    const price = PRICES.find((p) => this.options.model.startsWith(p.prefix)) ?? DEFAULT_PRICE;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    this.totals.calls += 1;
    this.totals.inputTokens += input;
    this.totals.outputTokens += output;
    this.totals.cacheReadTokens += cacheRead;
    this.totals.cacheWriteTokens += cacheWrite;
    this.totals.estimatedUsd +=
      (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1_000_000;
  }
}
