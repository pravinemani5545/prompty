// Deterministic renderer for vertical Shorts. Node calls setup(spec) once, then frame(i) for every frame.
import { createAvatar, findRating } from "./avatar.js";
import { chunkWords, wordTimings } from "./captions.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const easeOut = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

let spec = null;
let avatar = null;
let segments = [];
let lastFrame = -1;
let captionKey = "";

function setup(s) {
  spec = s;
  lastFrame = -1;
  captionKey = "";
  document.documentElement.style.setProperty("--accent", s.character.avatar.accentColor || "#7cf7ff");
  $("title").textContent = s.title || "";
  if (s.question) {
    $("question").hidden = false;
    $("question").dataset.platform = s.question.platform;
    $("q-user").textContent = s.question.user;
    $("q-text").textContent = s.question.text;
  }
  $("footer").textContent = `${s.character.socials.handle} · ${s.character.socials.cta}`;
  $("end-1").textContent = s.endCard.line1;
  $("end-2").textContent = s.endCard.line2;
  $("end-3").textContent = s.endCard.line3;
  avatar = createAvatar($("stage"), s.character.avatar, { seed: 11 });
  segments = s.segments.map((seg) => {
    const words = wordTimings(seg.text, seg.duration);
    return { ...seg, words, chunks: chunkWords(words), rating: findRating(seg.text), popped: false, ratingShown: false };
  });
}

function renderCaption(t) {
  // Keep the last line on screen briefly after it ends so it doesn't flash away.
  const seg = segments.find((s) => t >= s.start && t < s.start + s.duration + 0.25);
  let key = "";
  let html = "";
  if (seg) {
    const local = Math.min(t - seg.start, seg.duration - 0.001);
    let wordIndex = seg.words.findIndex((w) => local >= w.start && local < w.end);
    if (wordIndex < 0) wordIndex = seg.words.length - 1;
    const word = seg.words[wordIndex];
    const chunk = seg.chunks.find((c) => c.includes(word)) || seg.chunks[0];
    key = `${seg.start}:${wordIndex}`;
    html = chunk.map((w) => `<span class="w${w === word ? " now" : ""}">${escapeHtml(w.text)}</span>`).join("");
  }
  if (key !== captionKey) {
    captionKey = key;
    $("caption").innerHTML = html;
  }
}

function frame(i) {
  const t = i / spec.fps;
  const dt = lastFrame < 0 ? 1 / spec.fps : (i - lastFrame) / spec.fps;
  lastFrame = i;

  const first = segments[0];
  const seg = segments.find((s) => t >= s.start && t < s.start + s.duration);
  avatar.setThinking(Boolean(first) && t > 0.35 && t < first.start - 0.12);
  if (seg) {
    if (!seg.popped) {
      seg.popped = true;
      avatar.popToast();
    }
    avatar.setEmotion(seg.emotion);
    avatar.setTalking(true);
    avatar.setLevel(spec.envelope[i] ?? 0);
  } else {
    avatar.setTalking(false);
    avatar.setLevel(0);
  }
  for (const s of segments) {
    if (s.rating && !s.ratingShown && t >= s.start + s.duration - 0.25) {
      s.ratingShown = true;
      avatar.popToast(s.rating);
    }
  }
  avatar.update(dt);

  const titleIn = easeOut(t / 0.35);
  $("title").style.transform = `scale(${0.85 + 0.15 * titleIn})`;
  $("title").style.opacity = String(titleIn);
  if (spec.question) {
    const q = easeOut((t - 0.15) / 0.4);
    $("question").style.opacity = String(q);
    $("question").style.transform = `translateY(${(1 - q) * 60}px) scale(${0.9 + 0.1 * q})`;
  }
  renderCaption(t);
  const end = easeOut((t - spec.endCard.start) / 0.3);
  $("endcard").style.opacity = String(t >= spec.endCard.start ? end : 0);
}

window.shortRenderer = { ready: true, setup, frame };
