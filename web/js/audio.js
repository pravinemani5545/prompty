// Plays speech and measures its loudness so the avatar's mouth can follow it.

export class VoicePlayer {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
    this.audio = null;
    this.source = null;
    this.muted = false;
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
    this.buffer = new Float32Array(this.analyser.fftSize);
    return this.ctx;
  }

  /** True when the browser is blocking sound until the page is clicked (not an issue inside OBS). */
  get blocked() {
    return this.ctx?.state === "suspended";
  }

  async unlock() {
    await this.ensureContext().resume();
  }

  /** Resolves when playback ends (or fails). */
  play(url) {
    this.stop();
    const ctx = this.ensureContext();
    const audio = new Audio(url);
    audio.crossOrigin = "anonymous";
    const source = ctx.createMediaElementSource(audio);
    source.connect(this.analyser);
    if (this.muted) audio.muted = true;
    this.audio = audio;
    this.source = source;
    return new Promise((resolve) => {
      const done = (result) => {
        audio.onended = null;
        audio.onerror = null;
        resolve(result);
      };
      audio.onended = () => done("ended");
      audio.onerror = () => done("error");
      ctx.resume().catch(() => {});
      audio.play().catch(() => done("blocked"));
    });
  }

  stop() {
    if (this.audio) {
      this.audio.onended?.();
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
  }

  /** 0..1 loudness of what is playing right now. */
  level() {
    if (!this.audio || this.audio.paused || !this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const v of this.buffer) sum += v * v;
    const rms = Math.sqrt(sum / this.buffer.length);
    return rms < 0.015 ? 0 : Math.min(1, rms * 4.5);
  }

  progress() {
    if (!this.audio || !this.audio.duration || !Number.isFinite(this.audio.duration)) return 0;
    return Math.min(1, this.audio.currentTime / this.audio.duration);
  }

  /** The toaster "ding" when a reply pops out. */
  ding() {
    if (this.muted) return;
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    for (const [freq, gainValue] of [[1568, 0.12], [3136, 0.04]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(gainValue, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.95);
    }
  }
}

/** Fake mouth movement for when there is no audio (TTS turned off). */
export function syntheticLevel(t) {
  const v = 0.5 + 0.5 * Math.sin(t * 17) * Math.sin(t * 6.3 + 1);
  return v < 0.25 ? 0 : v;
}
