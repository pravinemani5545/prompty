import { Bus } from "./bus.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const REASONS = {
  crisis: "possible crisis - check on this viewer",
  profanity: "profanity/slur",
  blocked_term: "blocked term",
  injection: "prompt injection",
  link: "link",
  personal_info: "personal info",
  spam: "spam",
  too_long: "too long",
};

let state = null;
let pendingId = null;
const starred = new Set();

function control(action, extra = {}) {
  bus.send({ type: "control", action, ...extra });
}

function formatOffset(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function renderState(next) {
  state = next;
  const phase = next.paused ? "paused" : next.phase;
  $("phase").textContent = phase;
  $("phase").className = `pill ${phase}`;
  $("pause").textContent = next.paused ? "Resume" : "Pause";
  $("pause").classList.toggle("resume", next.paused);
  $("idle").checked = next.idleChatter;
  $("review").checked = next.reviewMode;
  $("brain").textContent = `Brain: ${next.brain}`;
  $("voice").textContent = `Voice: ${next.voice}`;
  $("spend").textContent = `~$${next.usage.estimatedUsd.toFixed(3)} (${next.usage.calls} calls)`;
  $("sources").textContent = next.sources.length
    ? next.sources.map((s) => `${s.name}: ${s.state}`).join(" · ")
    : "No chat sources (use Test chat, or set TWITCH_CHANNEL)";
  $("queue").innerHTML = next.queue.length
    ? next.queue
        .map((q) => `<li><span class="score">${q.score}</span><strong>${escapeHtml(q.user)}</strong>${q.paid ? `<span class="tag paid">${escapeHtml(q.paid)}</span>` : ""}${q.event ? `<span class="tag">${escapeHtml(q.event)}</span>` : ""}<div>${escapeHtml(q.text)}</div></li>`)
        .join("")
    : `<li class="hint">Nothing queued.</li>`;
}

function addChat({ message, verdict }) {
  const li = document.createElement("li");
  li.dataset.platform = message.platform;
  const tags = [];
  if (message.paid) tags.push(`<span class="tag paid">${escapeHtml(message.paid.display)}</span>`);
  if (message.event) tags.push(`<span class="tag">${escapeHtml(message.event)}</span>`);
  if (message.firstMessage) tags.push(`<span class="tag">first</span>`);
  if (!verdict.ok) {
    li.classList.add("blocked");
    if (verdict.alert) li.classList.add("alert");
    tags.push(`<span class="tag bad">${escapeHtml(REASONS[verdict.reason] || verdict.reason)}</span>`);
  }
  li.innerHTML = `<span class="user">${escapeHtml(message.user)}</span>${escapeHtml(message.text || message.eventText || "")}${tags.join("")}`;
  const list = $("chat");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.appendChild(li);
  while (list.children.length > 300) list.firstChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function addExchange(entry) {
  const li = document.createElement("li");
  li.dataset.id = entry.id;
  const to = entry.replyTo ? `to ${escapeHtml(entry.replyTo.user)}: "${escapeHtml(entry.replyTo.text)}"` : entry.kind;
  li.innerHTML = `
    <button class="star${starred.has(entry.id) || entry.starred ? " on" : ""}" title="Star to render as a Short">★</button>
    <div>
      <div class="to">${to}</div>
      <div>${escapeHtml(entry.say)}</div>
      <div class="when">${formatOffset(entry.offsetMs)} · ${entry.id}${entry.clipped ? " · clip" : ""}${entry.interrupted ? " · interrupted" : ""}</div>
    </div>`;
  li.querySelector(".star").onclick = (event) => {
    if (starred.has(entry.id)) return;
    starred.add(entry.id);
    event.currentTarget.classList.add("on");
    control("star", { id: entry.id });
  };
  const list = $("exchanges");
  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}

function addLog(entry) {
  const li = document.createElement("li");
  li.className = entry.level;
  li.textContent = `${new Date(entry.ts).toLocaleTimeString()} [${entry.scope}] ${entry.message}`;
  const list = $("logs");
  list.appendChild(li);
  while (list.children.length > 200) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

function showPending(utterance) {
  pendingId = utterance.id;
  $("pending").hidden = false;
  $("pending").querySelector(".pending-to").textContent = utterance.replyTo ? `Replying to ${utterance.replyTo.user}: "${utterance.replyTo.text}"` : "";
  $("pending").querySelector(".pending-text").textContent = `[${utterance.emotion}] ${utterance.text}`;
}

const bus = new Bus(
  "console",
  {
    character: ({ character }) => {
      $("char-name").textContent = character.name;
      document.title = `${character.name} · Stream Console`;
      for (const el of document.querySelectorAll(".cname")) el.textContent = character.name;
      $("emotions").innerHTML = character.emotions.map((e) => `<button data-emotion="${e}">${e}</button>`).join("");
      for (const button of $("emotions").querySelectorAll("button")) {
        button.onclick = () => control("emotion", { emotion: button.dataset.emotion });
      }
    },
    state: ({ state: next }) => renderState(next),
    history: ({ exchanges, logs }) => {
      $("exchanges").innerHTML = "";
      for (const entry of exchanges) addExchange(entry);
      $("logs").innerHTML = "";
      for (const entry of logs) addLog(entry);
    },
    chat: addChat,
    exchange: ({ entry }) => addExchange(entry),
    pending: ({ utterance }) => showPending(utterance),
    reviewed: ({ id }) => {
      if (id === pendingId) {
        pendingId = null;
        $("pending").hidden = true;
      }
    },
    star: ({ exchangeId }) => starred.add(exchangeId),
    clip: ({ offsetMs, reason }) => addLog({ level: "info", scope: "clip", ts: Date.now(), message: `clip marked at ${formatOffset(offsetMs)} (${reason})` }),
    alert: ({ message, reason }) => {
      const div = document.createElement("div");
      div.textContent = `${message.user}: "${message.text}" was flagged (${REASONS[reason] || reason}). The character did not reply. A human should follow up.`;
      $("alerts").appendChild(div);
    },
    log: ({ entry }) => addLog(entry),
    error: ({ error }) => addLog({ level: "error", scope: "console", ts: Date.now(), message: error }),
  },
  (connected) => $("link-dot").classList.toggle("on", connected),
);

$("pause").onclick = () => control(state?.paused ? "resume" : "pause");
$("skip").onclick = () => control("skip");
$("clip").onclick = () => control("clip");
$("idle").onchange = (e) => control("idle", { value: e.target.checked });
$("review").onchange = (e) => control("review", { value: e.target.checked });
$("approve").onclick = () => pendingId && control("approve", { id: pendingId });
$("reject").onclick = () => pendingId && control("reject", { id: pendingId });

function sendHandler(action) {
  const text = $("handler-text").value.trim();
  if (!text) return;
  control(action, { text });
  $("handler-text").value = "";
}
$("ask").onclick = () => sendHandler("handler");
$("say").onclick = () => sendHandler("say");
$("handler-text").onkeydown = (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendHandler("handler");
};

$("test-send").onclick = () => {
  const text = $("test-text").value.trim();
  if (!text) return;
  bus.send({ type: "chat", user: $("test-user").value.trim() || "tester", text });
  $("test-text").value = "";
};
$("test-text").onkeydown = (e) => {
  if (e.key === "Enter") $("test-send").click();
};

// Push-to-talk uses the browser's speech recognition (Chrome and Edge).
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const recognition = new Recognition();
  recognition.lang = navigator.language || "en-US";
  recognition.interimResults = false;
  let heard = "";
  recognition.onresult = (event) => {
    heard = [...event.results].map((r) => r[0].transcript).join(" ");
  };
  recognition.onend = () => {
    $("ptt").classList.remove("live");
    if (heard.trim()) control("handler", { text: heard.trim() });
    heard = "";
  };
  const start = () => {
    heard = "";
    $("ptt").classList.add("live");
    try {
      recognition.start();
    } catch {
      // Already listening.
    }
  };
  const stop = () => recognition.stop();
  $("ptt").onpointerdown = start;
  $("ptt").onpointerup = stop;
  $("ptt").onpointerleave = () => $("ptt").classList.contains("live") && stop();
  $("ptt-hint").textContent = "Hold the button (or the ` key) and speak. Release to send.";
  document.addEventListener("keydown", (e) => e.key === "`" && !e.repeat && document.activeElement.tagName !== "TEXTAREA" && start());
  document.addEventListener("keyup", (e) => e.key === "`" && stop());
} else {
  $("ptt").disabled = true;
  $("ptt-hint").textContent = "Push-to-talk needs Chrome or Edge. Type above instead.";
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") control(state?.paused ? "resume" : "pause");
  if (!e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "s") control("skip");
  if (key === "c") control("clip");
  if (key === "a" && pendingId) control("approve", { id: pendingId });
  if (key === "r" && pendingId) control("reject", { id: pendingId });
});
