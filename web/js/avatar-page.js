import { FALLBACK_AVATAR, createAvatar, findRating } from "./avatar.js";
import { VoicePlayer, syntheticLevel } from "./audio.js";
import { Bus } from "./bus.js";
import { LiveCaptions } from "./captions.js";

// Query options: ?captions=0 hides captions, ?question=0 hides the chat question,
// ?ding=0 mutes the toaster ding, ?preview=1 is a muted preview that doesn't affect timing.
const params = new URLSearchParams(location.search);
const preview = params.get("preview") === "1";
if (preview) document.body.classList.add("preview");

const character = await (await fetch("/api/character")).json();
document.documentElement.style.setProperty("--accent", character.avatar.accentColor || "#7cf7ff");
// Live2D models run to the bottom edge, with captions over the torso, instead of stopping above them.
document.body.classList.toggle("live2d", character.avatar.type === "live2d");

let avatar;
try {
  avatar = await createAvatar(document.getElementById("stage"), character.avatar);
} catch (error) {
  const problem = document.getElementById("problem");
  problem.hidden = false;
  problem.textContent =
    character.avatar.type === "live2d"
      ? `Live2D model didn't load (${error.message}). Run: npm run setup:live2d -- --accept`
      : `Avatar didn't load: ${error.message}`;
  avatar = await createAvatar(document.getElementById("stage"), { ...FALLBACK_AVATAR, label: character.name.toUpperCase() });
}
const captions = params.get("captions") === "0" ? null : new LiveCaptions(document.getElementById("captions"), character.name);
const player = new VoicePlayer();
player.muted = preview;

const unlockButton = document.getElementById("unlock");
unlockButton.onclick = async () => {
  await player.unlock();
  unlockButton.hidden = true;
};

let current = null;

function finish(id) {
  if (!current || current.utterance.id !== id) return;
  const rating = findRating(current.utterance.text);
  if (rating) avatar.popToast(rating);
  current = null;
  avatar.setTalking(false);
  captions?.hide(1800);
  if (!preview) bus.send({ type: "playback", id, event: "ended" });
}

async function speak(utterance) {
  player.stop();
  const startedAt = performance.now();
  current = { utterance, startedAt };
  avatar.setThinking(false);
  avatar.setEmotion(utterance.emotion);
  avatar.setTalking(true);
  avatar.popToast();
  if (params.get("ding") !== "0") player.ding();
  captions?.show(utterance, { question: params.get("question") !== "0" });

  if (utterance.audioUrl && !preview) {
    const result = await player.play(utterance.audioUrl);
    if (result === "blocked") {
      unlockButton.hidden = false;
      // Fall back to silent timing so the show keeps moving.
      setTimeout(() => finish(utterance.id), Math.max(0, utterance.durationMs - (performance.now() - startedAt)));
      return;
    }
    finish(utterance.id);
  } else {
    setTimeout(() => finish(utterance.id), utterance.durationMs);
  }
}

const bus = new Bus("avatar", {
  speak: ({ utterance }) => void speak(utterance),
  stop: () => {
    if (current) {
      const id = current.utterance.id;
      player.stop();
      finish(id);
    }
  },
  thinking: ({ on }) => avatar.setThinking(on),
  emotion: ({ emotion }) => avatar.setEmotion(emotion),
});

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (current) {
    const elapsed = (now - current.startedAt) / 1000;
    const silent = !current.utterance.audioUrl || preview || player.blocked;
    avatar.setLevel(silent ? syntheticLevel(elapsed) : player.level());
    const progress = silent ? elapsed / (current.utterance.durationMs / 1000) : player.progress();
    captions?.progress(Math.min(1, progress));
  } else {
    avatar.setLevel(0);
  }
  avatar.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__avatar = { avatar, speak };
