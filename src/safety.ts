import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

export type InputBlockReason =
  | "empty"
  | "too_long"
  | "crisis"
  | "profanity"
  | "blocked_term"
  | "injection"
  | "link"
  | "personal_info"
  | "spam";

export type InputVerdict = { ok: true } | { ok: false; reason: InputBlockReason; alert: boolean };

export type OutputVerdict = { ok: true; text: string } | { ok: false; reason: string };

/** Swear words that `allowProfanity: true` unlocks. Slurs and sexual terms stay blocked regardless. */
const MILD_PROFANITY = new Set(["arse", "ass", "bastard", "bollocks", "fuck", "piss", "shit", "turd"]);

const CRISIS =
  /\b(kill(ing)? my ?self|suicid(e|al)|self[- ]?harm(ing)?|end(ing)? (it all|my life)|want(ed)? to die|cut(ting)? my ?self|no reason to (live|be alive))\b/i;

const INJECTION = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(instructions|rules|prompts?|guidelines)\b/i,
  /\b(system|developer|hidden) (prompt|message|instructions)\b/i,
  /\b(your|the) (instructions|system prompt|rules) (are|say)\b/i,
  /\b(jailbreak|dan mode|developer mode|god mode)\b/i,
  /\byou are now (a|an|in|no longer)\b/i,
  /\bfrom now on,? (you|your)\b/i,
  /\b(repeat|say|type|read) (after me|exactly|verbatim|word for word|the following|this back)\b/i,
  /\bpretend (to be|you are|you're)\b/i,
  /\bnew (instructions|rules|persona)\b/i,
];

const LINK = /\b(https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(com|net|org|io|gg|tv|ly|me|co|xyz|ru|app|link|shop|site)\b/i;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
const PHONE = /(?:\+?\d[\s().-]{0,2}){9,}\d/;
const REPEATED_CHAR = /(.)\1{9,}/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cleans a reply so it can be spoken: no markup, links, emoji or stage directions, and a length cap. */
export function sanitizeSpoken(text: string, maxChars: number): string {
  let out = text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    // *pops toast* at the start of a sentence is a stage direction: drop it.
    .replace(/(^|[.!?]\s+)\*[^*\n]{1,60}\*\s*/g, "$1")
    // Any other *word* is emphasis: keep the word.
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/\((?:laughs?|sighs?|giggles?|whispers?|beat|pause|smirks?|gasps?)[^)]{0,30}\)/gi, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/@(everyone|here)\b/gi, "everyone")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, " ")
    .replace(/[#*`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    out = lastEnd > maxChars * 0.4 ? cut.slice(0, lastEnd + 1) : `${cut.replace(/\s+\S*$/, "")}...`;
  }
  return out;
}

export interface SafetyOptions {
  allowProfanity: boolean;
  blockedTerms: string[];
  maxInputChars?: number;
  maxReplyChars: number;
}

export class Safety {
  private readonly matcher: RegExpMatcher;
  private readonly blocked: RegExp | null;

  constructor(private readonly options: SafetyOptions) {
    const dataset = options.allowProfanity
      ? englishDataset.removePhrasesIf((phrase) => MILD_PROFANITY.has(phrase.metadata?.originalWord ?? ""))
      : englishDataset;
    this.matcher = new RegExpMatcher({ ...dataset.build(), ...englishRecommendedTransformers });
    const terms = options.blockedTerms.map((t) => t.trim()).filter(Boolean);
    this.blocked = terms.length > 0 ? new RegExp(`\\b(${terms.map(escapeRegExp).join("|")})\\b`, "i") : null;
  }

  /** Decides whether a chat message may be answered at all. */
  screenInput(text: string): InputVerdict {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "empty", alert: false };
    if (trimmed.length > (this.options.maxInputChars ?? 400)) return { ok: false, reason: "too_long", alert: false };
    // Checked first: a person in crisis needs a human moderator, not a roast.
    if (CRISIS.test(trimmed)) return { ok: false, reason: "crisis", alert: true };
    if (this.matcher.hasMatch(trimmed)) return { ok: false, reason: "profanity", alert: false };
    if (this.blocked?.test(trimmed)) return { ok: false, reason: "blocked_term", alert: false };
    if (INJECTION.some((pattern) => pattern.test(trimmed))) return { ok: false, reason: "injection", alert: false };
    // Before the link check: an email address also looks like a domain.
    if (EMAIL.test(trimmed) || PHONE.test(trimmed)) return { ok: false, reason: "personal_info", alert: false };
    if (LINK.test(trimmed)) return { ok: false, reason: "link", alert: false };
    const letters = trimmed.replace(/[^\p{L}]/gu, "").length;
    if (REPEATED_CHAR.test(trimmed) || (trimmed.length > 8 && letters / trimmed.length < 0.3)) {
      return { ok: false, reason: "spam", alert: false };
    }
    return { ok: true };
  }

  /** Cleans a generated reply and decides whether it may be spoken. */
  screenOutput(text: string): OutputVerdict {
    const clean = sanitizeSpoken(text, this.options.maxReplyChars);
    if (!clean) return { ok: false, reason: "empty" };
    if (this.matcher.hasMatch(clean)) return { ok: false, reason: "profanity" };
    if (this.blocked?.test(clean)) return { ok: false, reason: "blocked_term" };
    if (/\bas an ai (language )?model\b/i.test(clean)) return { ok: false, reason: "persona_break" };
    return { ok: true, text: clean };
  }
}
