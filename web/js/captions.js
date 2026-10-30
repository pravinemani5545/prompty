// Word-by-word captions. Used live (progress from the audio) and in Shorts (progress from the timeline).

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Splits a line into words with rough timings: longer words and punctuation take longer. */
export function wordTimings(text, durationSec) {
  const words = text.split(/\s+/).filter(Boolean);
  const weights = words.map((w) => w.length + 2 + (/[.!?]$/.test(w) ? 5 : /[,;:]$/.test(w) ? 2.5 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return words.map((word, i) => {
    const length = (weights[i] / total) * durationSec;
    const timing = { text: word, start: t, end: t + length };
    t += length;
    return timing;
  });
}

/** Groups words into short on-screen chunks, karaoke style. */
export function chunkWords(words, maxChars = 26, maxWords = 5) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const word of words) {
    if (current.length > 0 && (chars + word.text.length > maxChars || current.length >= maxWords)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(word);
    chars += word.text.length + 1;
    if (/[.!?]$/.test(word.text)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
  }
  if (current.length > 0) chunks.push(current);
  // Don't leave one word stranded at the end of a sentence: fold it into the chunk before.
  for (let i = chunks.length - 1; i > 0; i--) {
    const prev = chunks[i - 1];
    const lonely = chunks[i];
    const prevEndsSentence = /[.!?]$/.test(prev[prev.length - 1].text);
    const combined = [...prev, ...lonely].reduce((n, w) => n + w.text.length + 1, 0);
    if (lonely.length === 1 && !prevEndsSentence && combined <= maxChars + 10) {
      chunks.splice(i - 1, 2, [...prev, ...lonely]);
    }
  }
  return chunks;
}

export class LiveCaptions {
  constructor(root, speakerName) {
    this.root = root;
    this.root.innerHTML = `
      <div class="cap-question" hidden><span class="cap-user"></span><span class="cap-qtext"></span></div>
      <div class="cap-line" hidden><span class="cap-name">${escapeHtml(speakerName)}</span><span class="cap-text"></span></div>`;
    this.question = root.querySelector(".cap-question");
    this.line = root.querySelector(".cap-line");
    this.text = root.querySelector(".cap-text");
    this.words = [];
    this.hideTimer = null;
  }

  show(utterance, options = {}) {
    clearTimeout(this.hideTimer);
    const reply = utterance.replyTo;
    if (reply && reply.text && options.question !== false) {
      this.question.hidden = false;
      this.question.querySelector(".cap-user").textContent = reply.user;
      this.question.querySelector(".cap-qtext").textContent = reply.text;
      this.question.dataset.platform = reply.platform;
    } else {
      this.question.hidden = true;
    }
    this.words = utterance.text.split(/\s+/).filter(Boolean);
    this.text.innerHTML = this.words.map((w) => `<span class="w">${escapeHtml(w)}</span>`).join(" ");
    this.spans = [...this.text.querySelectorAll(".w")];
    this.line.hidden = false;
    this.root.classList.add("visible");
    this.progress(0);
  }

  /** Reveals words up to `p` (0..1) of the way through the line. */
  progress(p) {
    if (!this.spans) return;
    const shown = Math.ceil(p * this.spans.length + 0.0001);
    this.spans.forEach((span, i) => {
      span.classList.toggle("on", i < shown);
      span.classList.toggle("now", i === shown - 1);
    });
  }

  hide(delayMs = 0) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.root.classList.remove("visible"), delayMs);
  }
}
