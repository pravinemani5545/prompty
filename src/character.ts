import fs from "node:fs";
import YAML from "yaml";
import { EMOTIONS } from "./types.js";

export type AvatarConfig =
  | {
      type: "toaster";
      label: string;
      bodyColor: string;
      accentColor: string;
      screenColor: string;
    }
  | {
      type: "png";
      /** URL path the PNGs are served from, e.g. /assets/my-character */
      basePath: string;
      /** Per-emotion images. `neutral` is required; other emotions fall back to it. */
      states: Record<string, { closed: string; open?: string; blink?: string }>;
    };

export interface Character {
  name: string;
  pronouns: string;
  tagline: string;
  fanName?: string;
  handler: { name: string; description: string };
  identity: string;
  personality: string[];
  speakingStyle: string[];
  catchphrases: string[];
  recurringBits: string[];
  lore: string[];
  boundaries: string[];
  idleTopics: string[];
  fallbackLines: string[];
  deflections: string[];
  blockedTerms: string[];
  allowProfanity: boolean;
  maxReplyChars: number;
  avatar: AvatarConfig;
  voice: { babblePitch: number; elevenlabsVoiceId?: string; openaiVoice?: string };
  socials: { handle: string; cta: string };
  /** Hook text on Shorts made from chat moments. */
  shortsTitle: string;
}

type Raw = Record<string, unknown>;

function asString(raw: Raw, key: string, required: true): string;
function asString(raw: Raw, key: string, required?: false): string | undefined;
function asString(raw: Raw, key: string, required = false): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`character: "${key}" is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`character: "${key}" must be text`);
  return value.trim();
}

function asList(raw: Raw, key: string, required = false): string[] {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`character: "${key}" is required (a list)`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`character: "${key}" must be a list of text lines`);
  }
  return value.map((v: string) => v.trim()).filter(Boolean);
}

function asObject(raw: Raw, key: string): Raw {
  const value = raw[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`character: "${key}" must be a mapping`);
  return value as Raw;
}

function parseAvatar(raw: Raw, name: string): AvatarConfig {
  const type = asString(raw, "type") ?? "toaster";
  if (type === "toaster") {
    return {
      type,
      label: asString(raw, "label") ?? name.toUpperCase(),
      bodyColor: asString(raw, "bodyColor") ?? "#8FE3CF",
      accentColor: asString(raw, "accentColor") ?? "#7CF7FF",
      screenColor: asString(raw, "screenColor") ?? "#141A33",
    };
  }
  if (type === "png") {
    const basePath = asString(raw, "basePath", true);
    const states = asObject(raw, "states");
    const parsed: Record<string, { closed: string; open?: string; blink?: string }> = {};
    for (const [emotion, value] of Object.entries(states)) {
      if (!(EMOTIONS as readonly string[]).includes(emotion)) {
        throw new Error(`character: avatar state "${emotion}" is not one of ${EMOTIONS.join(", ")}`);
      }
      const state = value as Raw;
      parsed[emotion] = {
        closed: asString(state, "closed", true),
        open: asString(state, "open"),
        blink: asString(state, "blink"),
      };
    }
    if (!parsed.neutral) throw new Error('character: png avatars need at least a "neutral" state');
    return { type, basePath: basePath.replace(/\/+$/, ""), states: parsed };
  }
  throw new Error(`character: avatar.type must be "toaster" or "png" (got "${type}")`);
}

export function parseCharacter(source: string): Character {
  const raw = YAML.parse(source) as Raw | null;
  if (!raw || typeof raw !== "object") throw new Error("character: file is empty or not a mapping");

  const name = asString(raw, "name", true);
  const handler = asObject(raw, "handler");
  const voice = asObject(raw, "voice");
  const socials = asObject(raw, "socials");
  const maxReplyChars = raw.maxReplyChars === undefined ? 320 : Number(raw.maxReplyChars);
  if (!Number.isFinite(maxReplyChars) || maxReplyChars < 60) {
    throw new Error("character: maxReplyChars must be a number of at least 60");
  }

  const character: Character = {
    name,
    pronouns: asString(raw, "pronouns") ?? "they/them",
    tagline: asString(raw, "tagline", true),
    fanName: asString(raw, "fanName"),
    handler: {
      name: asString(handler, "name") ?? "the Handler",
      description: asString(handler, "description") ?? "The human who runs the stream.",
    },
    identity: asString(raw, "identity", true),
    personality: asList(raw, "personality", true),
    speakingStyle: asList(raw, "speakingStyle", true),
    catchphrases: asList(raw, "catchphrases"),
    recurringBits: asList(raw, "recurringBits"),
    lore: asList(raw, "lore"),
    boundaries: asList(raw, "boundaries", true),
    idleTopics: asList(raw, "idleTopics"),
    fallbackLines: asList(raw, "fallbackLines"),
    deflections: asList(raw, "deflections"),
    blockedTerms: asList(raw, "blockedTerms"),
    allowProfanity: raw.allowProfanity === true,
    maxReplyChars,
    avatar: parseAvatar(asObject(raw, "avatar"), name),
    voice: {
      babblePitch: voice.babblePitch === undefined ? 1 : Number(voice.babblePitch),
      elevenlabsVoiceId: asString(voice, "elevenlabsVoiceId"),
      openaiVoice: asString(voice, "openaiVoice"),
    },
    socials: {
      handle: asString(socials, "handle") ?? `@${name.toLowerCase()}`,
      cta: asString(socials, "cta") ?? "Live on Twitch",
    },
    shortsTitle: asString(raw, "shortsTitle") ?? `Chat vs ${name}`,
  };
  if (character.fallbackLines.length === 0) character.fallbackLines.push("Give me a second, chat.");
  if (character.deflections.length === 0) character.deflections.push("Nice try. Next!");
  return character;
}

export function loadCharacter(file: string): Character {
  try {
    return parseCharacter(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load character from ${file}: ${reason}`);
  }
}

/** The subset of the character the browser pages need. */
export function publicCharacter(character: Character) {
  return {
    name: character.name,
    fanName: character.fanName,
    avatar: character.avatar,
    socials: character.socials,
    catchphrase: character.catchphrases[0] ?? "",
    emotions: EMOTIONS,
  };
}

export function pick<T>(items: readonly T[], random: () => number = Math.random): T {
  if (items.length === 0) throw new Error("pick() needs at least one item");
  return items[Math.floor(random() * items.length)] as T;
}
