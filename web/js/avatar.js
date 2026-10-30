// Avatar renderers. Both expose the same API so pages don't care which one is loaded:
//   setEmotion(e) setLevel(0..1) setTalking(bool) setThinking(bool) popToast(burn?) update(dtSeconds)

const NS = "http://www.w3.org/2000/svg";
const OUTLINE = "#23304A";
const BURN = { raw: "#F6E7C1", golden: "#F2C879", toasted: "#D99A4E", burnt: "#8B5A2B", charcoal: "#3A2A22" };

function el(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (parent) parent.appendChild(node);
  return node;
}

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const approach = (current, target, rate, dt) => current + (target - current) * Math.min(1, dt * rate);

function pill(cx, cy, w, h) {
  const r = Math.min(w, h) / 2;
  const x = cx - w / 2;
  const y = cy - h / 2;
  return `M${x + r},${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r},${y + h} H${x + r} A${r} ${r} 0 0 1 ${x},${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r},${y} Z`;
}

function ellipse(cx, cy, rx, ry) {
  return `M${cx - rx},${cy} A${rx} ${ry} 0 1 0 ${cx + rx},${cy} A${rx} ${ry} 0 1 0 ${cx - rx},${cy} Z`;
}

function crescentUp(cx, cy, w, h) {
  // A "^" shaped eye: thick arc, filled.
  return `M${cx - w / 2},${cy + h / 3} Q${cx},${cy - h} ${cx + w / 2},${cy + h / 3} Q${cx},${cy - h / 3} ${cx - w / 2},${cy + h / 3} Z`;
}

function chevron(cx, cy, size, pointRight) {
  const d = pointRight ? 1 : -1;
  const s = size;
  return `M${cx - d * s * 0.6},${cy - s} L${cx + d * s * 0.7},${cy} L${cx - d * s * 0.6},${cy + s} L${cx - d * s * 0.6},${cy + s * 0.45} L${cx + d * s * 0.05},${cy} L${cx - d * s * 0.6},${cy - s * 0.45} Z`;
}

function sparkle(cx, cy, r) {
  return `M${cx},${cy - r} Q${cx + r * 0.18},${cy - r * 0.18} ${cx + r},${cy} Q${cx + r * 0.18},${cy + r * 0.18} ${cx},${cy + r} Q${cx - r * 0.18},${cy + r * 0.18} ${cx - r},${cy} Q${cx - r * 0.18},${cy - r * 0.18} ${cx},${cy - r} Z`;
}

function seeded(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Crumb: a toaster with a screen for a face. Pure SVG, no assets needed. */
export class ToasterAvatar {
  constructor(container, config, options = {}) {
    this.config = config;
    this.random = options.seed !== undefined ? seeded(options.seed) : Math.random;
    this.s = {
      t: 0,
      emotion: "neutral",
      level: 0,
      mouth: 0,
      talking: false,
      thinking: false,
      blinkLeft: 0,
      nextBlink: 1.5 + this.random() * 3,
      lookX: 0,
      lookY: 0,
      lookTargetX: 0,
      lookTargetY: 0,
      nextLook: 1,
      toast: 0,
      toastTarget: 0,
      popTimer: 0,
      burn: "golden",
      lever: 0,
      steamTimer: 0,
      steam: 0,
    };
    this.build(container);
    this.update(0);
  }

  build(container) {
    const c = this.config;
    const svg = el("svg", { viewBox: "0 0 600 600", class: "avatar-svg", role: "img", "aria-label": c.label || "avatar" });
    const defs = el("defs", {}, svg);
    const glow = el("filter", { id: "glow", x: "-30%", y: "-30%", width: "160%", height: "160%" }, defs);
    el("feGaussianBlur", { stdDeviation: 3.5, result: "blur" }, glow);
    const merge = el("feMerge", {}, glow);
    el("feMergeNode", { in: "blur" }, merge);
    el("feMergeNode", { in: "SourceGraphic" }, merge);
    const screenClip = el("clipPath", { id: "screen-clip" }, defs);
    el("rect", { x: 165, y: 255, width: 270, height: 175, rx: 36 }, screenClip);
    const bodyClip = el("clipPath", { id: "body-clip" }, defs);
    el("rect", { x: 110, y: 205, width: 380, height: 290, rx: 78 }, bodyClip);

    this.shadow = el("ellipse", { cx: 300, cy: 548, rx: 150, ry: 16, fill: "rgba(0,0,0,0.22)" }, svg);
    this.root = el("g", {}, svg);

    // Steam puffs float above the toast when something gets rated Burnt or Charcoal.
    this.steamGroup = el("g", { opacity: 0 }, this.root);
    this.puffs = [250, 300, 350].map((x, i) => el("circle", { cx: x, cy: 110, r: 16 + i * 3, fill: "#E9EEF5" }, this.steamGroup));

    // Toast lives behind the body and pops out of the slots.
    this.toastGroup = el("g", {}, this.root);
    this.slices = [185, 315].map((x) => {
      const g = el("g", { transform: `translate(${x},175)` }, this.toastGroup);
      el("path", { d: "M10,52 C-6,22 22,0 50,6 C78,0 106,22 90,52 L90,150 L10,150 Z", fill: "#C8843A", stroke: OUTLINE, "stroke-width": 7, "stroke-linejoin": "round" }, g);
      return el("path", { d: "M21,55 C11,33 30,17 50,21 C70,17 89,33 79,55 L79,150 L21,150 Z", fill: BURN.golden }, g);
    });

    // Body.
    el("rect", { x: 110, y: 205, width: 380, height: 290, rx: 78, fill: c.bodyColor }, this.root);
    const shade = el("g", { "clip-path": "url(#body-clip)" }, this.root);
    el("rect", { x: 100, y: 440, width: 400, height: 70, fill: "rgba(0,0,0,0.10)" }, shade);
    el("rect", { x: 140, y: 226, width: 150, height: 20, rx: 10, fill: "rgba(255,255,255,0.4)" }, shade);
    el("rect", { x: 110, y: 205, width: 380, height: 290, rx: 78, fill: "none", stroke: OUTLINE, "stroke-width": 10 }, this.root);

    // Slots with heating-coil glow.
    for (const x of [180, 310]) el("rect", { x, y: 196, width: 110, height: 20, rx: 10, fill: OUTLINE }, this.root);
    this.coils = [188, 318].map((x) => el("rect", { x, y: 201, width: 94, height: 10, rx: 5, fill: "#FF7A2F", opacity: 0 }, this.root));

    // Lever on the side: it goes down while the character is thinking ("toasting").
    el("rect", { x: 482, y: 268, width: 16, height: 150, rx: 8, fill: OUTLINE }, this.root);
    this.lever = el("g", {}, this.root);
    el("rect", { x: 476, y: 262, width: 46, height: 28, rx: 12, fill: "#FF6B6B", stroke: OUTLINE, "stroke-width": 6 }, this.lever);

    // Feet and name plate.
    for (const x of [165, 365]) el("rect", { x, y: 486, width: 70, height: 26, rx: 12, fill: OUTLINE }, this.root);
    const label = el("text", {
      x: 300, y: 470, "text-anchor": "middle", "font-size": 26, "font-weight": 800, "letter-spacing": 6,
      fill: OUTLINE, opacity: 0.55, "font-family": "'Arial Rounded MT Bold', Nunito, 'Segoe UI', Arial, sans-serif",
    }, this.root);
    label.textContent = c.label || "";

    // Screen face.
    el("rect", { x: 165, y: 255, width: 270, height: 175, rx: 36, fill: c.screenColor, stroke: OUTLINE, "stroke-width": 8 }, this.root);
    const face = el("g", { "clip-path": "url(#screen-clip)" }, this.root);
    el("path", { d: "M180,268 L238,268 L196,338 L180,338 Z", fill: "rgba(255,255,255,0.05)" }, face);
    this.blush = [212, 388].map((x) => el("ellipse", { cx: x, cy: 382, rx: 24, ry: 11, fill: "#FF8FB1", opacity: 0 }, face));
    const glowing = el("g", { filter: "url(#glow)" }, face);
    this.eyes = [0, 1].map(() => el("path", { d: "", fill: c.accentColor }, glowing));
    this.brows = [0, 1].map(() => el("path", { d: "", fill: "none", stroke: c.accentColor, "stroke-width": 7, "stroke-linecap": "round", opacity: 0 }, glowing));
    this.mouth = el("path", { d: "", fill: c.accentColor }, glowing);
    this.dots = [272, 300, 328].map((x) => el("circle", { cx: x, cy: 388, r: 7, fill: c.accentColor, opacity: 0 }, glowing));
    this.sparkles = [[198, 290], [404, 296]].map(([x, y]) => el("path", { d: sparkle(x, y, 12), fill: c.accentColor, opacity: 0 }, glowing));

    container.replaceChildren(svg);
    this.svg = svg;
  }

  setEmotion(emotion) {
    this.s.emotion = emotion;
  }

  setLevel(level) {
    this.s.level = clamp(level);
  }

  setTalking(on) {
    this.s.talking = on;
  }

  setThinking(on) {
    this.s.thinking = on;
  }

  /** Pops the toast up for a moment. Burn: raw | golden | toasted | burnt | charcoal. */
  popToast(burn) {
    if (burn && BURN[burn]) this.s.burn = burn;
    this.s.toastTarget = 1;
    this.s.popTimer = 1.4;
    if (burn === "burnt" || burn === "charcoal") this.s.steamTimer = 2.8;
  }

  update(dt) {
    const s = this.s;
    s.t += dt;
    s.mouth = approach(s.mouth, s.talking ? s.level : 0, 22, dt);

    s.nextBlink -= dt;
    if (s.nextBlink <= 0) {
      s.blinkLeft = 0.13;
      s.nextBlink = 2 + this.random() * 4;
    }
    s.blinkLeft = Math.max(0, s.blinkLeft - dt);
    const blink = s.blinkLeft > 0 ? Math.sin((s.blinkLeft / 0.13) * Math.PI) : 0;

    s.nextLook -= dt;
    if (s.nextLook <= 0) {
      s.lookTargetX = (this.random() - 0.5) * 14;
      s.lookTargetY = (this.random() - 0.5) * 8;
      s.nextLook = 1.2 + this.random() * 2.6;
    }
    s.lookX = approach(s.lookX, s.thinking ? 10 : s.lookTargetX, 8, dt);
    s.lookY = approach(s.lookY, s.thinking ? -9 : s.lookTargetY, 8, dt);

    if (s.popTimer > 0) {
      s.popTimer -= dt;
      if (s.popTimer <= 0) s.toastTarget = 0;
    }
    s.toast = approach(s.toast, s.toastTarget, s.toastTarget > s.toast ? 16 : 4, dt);
    s.lever = approach(s.lever, s.thinking ? 1 : 0, 10, dt);
    s.steamTimer = Math.max(0, s.steamTimer - dt);
    s.steam = approach(s.steam, s.steamTimer > 0 || s.emotion === "angry" ? 1 : 0, 3, dt);

    this.render(blink);
  }

  render(blink) {
    const s = this.s;
    const e = s.emotion;
    const bob = Math.sin(s.t * 1.7) * 4 - s.mouth * 8 + (e === "excited" ? Math.abs(Math.sin(s.t * 7)) * -6 : 0);
    const squash = 1 + s.mouth * 0.035;
    this.root.setAttribute("transform", `translate(0 ${bob.toFixed(2)}) translate(300 540) scale(${(1 / squash).toFixed(4)} ${squash.toFixed(4)}) translate(-300 -540)`);
    this.shadow.setAttribute("rx", (150 - bob * 1.5).toFixed(1));

    this.toastGroup.setAttribute("transform", `translate(0 ${(-s.toast * 78).toFixed(2)})`);
    for (const slice of this.slices) slice.setAttribute("fill", BURN[s.burn]);
    this.lever.setAttribute("transform", `translate(0 ${(s.lever * 96).toFixed(2)})`);
    const coil = s.thinking ? 0.55 + 0.45 * Math.sin(s.t * 9) : s.lever * 0.6;
    for (const rect of this.coils) rect.setAttribute("opacity", coil.toFixed(2));

    this.steamGroup.setAttribute("opacity", s.steam.toFixed(2));
    this.puffs.forEach((puff, i) => {
      const phase = (s.t * 0.8 + i * 0.33) % 1;
      puff.setAttribute("cy", (130 - phase * 60).toFixed(1));
      puff.setAttribute("opacity", (1 - phase).toFixed(2));
    });

    // Eyes.
    const lx = 245 + s.lookX;
    const rx = 355 + s.lookX;
    const ey = 326 + s.lookY;
    const open = 1 - blink * 0.92;
    let left;
    let right;
    let browOpacity = 0;
    let brows = ["", ""];
    let sparkle = 0;
    if (s.thinking) {
      left = pill(lx, ey, 32, 46 * open);
      right = pill(rx, ey, 32, 46 * open);
    } else if (e === "happy" || e === "excited") {
      const size = e === "excited" ? 1.18 : 1;
      left = crescentUp(lx, ey + 4, 48 * size, 30 * size);
      right = crescentUp(rx, ey + 4, 48 * size, 30 * size);
      sparkle = e === "excited" ? 0.6 + 0.4 * Math.sin(s.t * 6) : 0;
    } else if (e === "surprised") {
      left = ellipse(lx, ey, 22, 24 * open);
      right = ellipse(rx, ey, 22, 24 * open);
    } else if (e === "embarrassed") {
      left = chevron(lx, ey + 2, 18, true);
      right = chevron(rx, ey + 2, 18, false);
    } else if (e === "smug") {
      left = pill(lx, ey + 9, 34, 22 * open);
      right = pill(rx, ey + 7, 34, 26 * open);
      brows = [`M${lx - 20},${ey - 10} L${lx + 18},${ey - 8}`, `M${rx - 18},${ey - 24} Q${rx},${ey - 32} ${rx + 20},${ey - 22}`];
      browOpacity = 1;
    } else if (e === "angry") {
      left = pill(lx, ey + 6, 32, 34 * open);
      right = pill(rx, ey + 6, 32, 34 * open);
      brows = [`M${lx - 20},${ey - 22} L${lx + 18},${ey - 10}`, `M${rx - 18},${ey - 10} L${rx + 20},${ey - 22}`];
      browOpacity = 1;
    } else if (e === "sad") {
      left = pill(lx, ey + 8, 30, 36 * open);
      right = pill(rx, ey + 8, 30, 36 * open);
      brows = [`M${lx - 18},${ey - 12} L${lx + 18},${ey - 22}`, `M${rx - 18},${ey - 22} L${rx + 18},${ey - 12}`];
      browOpacity = 1;
    } else {
      left = pill(lx, ey, 32, 46 * open);
      right = pill(rx, ey, 32, 46 * open);
    }
    this.eyes[0].setAttribute("d", left);
    this.eyes[1].setAttribute("d", right);
    this.brows.forEach((brow, i) => {
      brow.setAttribute("d", brows[i] || "M0,0");
      brow.setAttribute("opacity", String(browOpacity));
    });
    for (const sp of this.sparkles) sp.setAttribute("opacity", sparkle.toFixed(2));
    const blushTarget = e === "embarrassed" ? 0.85 : e === "happy" || e === "excited" ? 0.45 : 0;
    for (const b of this.blush) b.setAttribute("opacity", String(blushTarget));

    // Mouth.
    const mx = 300;
    const my = 386;
    const m = s.mouth;
    let mouth;
    if (s.thinking) {
      mouth = "M0,0";
      this.dots.forEach((dot, i) => {
        dot.setAttribute("opacity", "1");
        dot.setAttribute("cy", (388 - Math.max(0, Math.sin(s.t * 6 - i * 0.7)) * 9).toFixed(1));
      });
    } else {
      for (const dot of this.dots) dot.setAttribute("opacity", "0");
      if (m > 0.04) {
        const w = 40 + m * 12;
        const h = 6 + m * 34;
        if (e === "happy" || e === "excited") {
          mouth = `M${mx - w / 2},${my - h * 0.25} H${mx + w / 2} Q${mx + w / 2},${my + h} ${mx},${my + h} Q${mx - w / 2},${my + h} ${mx - w / 2},${my - h * 0.25} Z`;
        } else if (e === "sad") {
          mouth = `M${mx - w / 2},${my + h * 0.6} Q${mx - w / 2},${my - h * 0.6} ${mx},${my - h * 0.6} Q${mx + w / 2},${my - h * 0.6} ${mx + w / 2},${my + h * 0.6} Z`;
        } else {
          mouth = ellipse(mx, my + h * 0.1, w / 2, h / 2);
        }
      } else if (e === "happy" || e === "excited") {
        mouth = `M${mx - 24},${my - 5} Q${mx},${my + 20} ${mx + 24},${my - 5} Q${mx},${my + 7} ${mx - 24},${my - 5} Z`;
      } else if (e === "smug") {
        mouth = `M${mx - 20},${my + 3} Q${mx + 4},${my + 13} ${mx + 26},${my - 9} Q${mx + 4},${my + 4} ${mx - 20},${my + 3} Z`;
      } else if (e === "sad" || e === "angry") {
        mouth = `M${mx - 22},${my + 10} Q${mx},${my - 10} ${mx + 22},${my + 10} Q${mx},${my} ${mx - 22},${my + 10} Z`;
      } else if (e === "surprised") {
        mouth = ellipse(mx, my + 2, 11, 13);
      } else if (e === "embarrassed") {
        mouth = pill(mx, my + 2, 24, 7);
      } else {
        mouth = pill(mx, my, 36, 8);
      }
    }
    this.mouth.setAttribute("d", mouth);
  }
}

/**
 * Classic PNGtuber: one image per emotion with mouth closed/open and an optional blink frame.
 * Configure it in the character file (avatar.type: png).
 */
export class PngAvatar {
  constructor(container, config, options = {}) {
    this.config = config;
    this.random = options.seed !== undefined ? seeded(options.seed) : Math.random;
    this.s = { t: 0, emotion: "neutral", level: 0, mouth: 0, talking: false, thinking: false, blinkLeft: 0, nextBlink: 2, open: false, toast: 0 };
    this.img = document.createElement("img");
    this.img.className = "avatar-png";
    this.img.alt = "avatar";
    container.replaceChildren(this.img);
    // Preload every frame so swaps never flicker.
    for (const state of Object.values(config.states)) {
      for (const file of [state.closed, state.open, state.blink]) if (file) new Image().src = `${config.basePath}/${file}`;
    }
    this.update(0);
  }

  setEmotion(emotion) {
    this.s.emotion = emotion;
  }

  setLevel(level) {
    this.s.level = clamp(level);
  }

  setTalking(on) {
    this.s.talking = on;
  }

  setThinking(on) {
    this.s.thinking = on;
  }

  popToast() {
    this.s.toast = 1;
  }

  update(dt) {
    const s = this.s;
    s.t += dt;
    s.mouth = approach(s.mouth, s.talking ? s.level : 0, 22, dt);
    // Hysteresis keeps the mouth from flickering around the threshold.
    s.open = s.open ? s.mouth > 0.12 : s.mouth > 0.22;
    s.nextBlink -= dt;
    if (s.nextBlink <= 0) {
      s.blinkLeft = 0.12;
      s.nextBlink = 2 + this.random() * 4;
    }
    s.blinkLeft = Math.max(0, s.blinkLeft - dt);
    s.toast = Math.max(0, s.toast - dt * 3);

    const state = this.config.states[s.emotion] || this.config.states.neutral;
    let file = state.closed;
    if (s.open && state.open) file = state.open;
    else if (s.blinkLeft > 0 && state.blink) file = state.blink;
    const src = `${this.config.basePath}/${file}`;
    if (this.img.getAttribute("src") !== src) this.img.setAttribute("src", src);

    const bob = Math.sin(s.t * 1.7) * 6 - s.mouth * 10 - s.toast * 18;
    const squash = 1 + s.mouth * 0.03;
    this.img.style.transform = `translateY(${bob.toFixed(1)}px) scale(${(1 / squash).toFixed(3)}, ${squash.toFixed(3)})`;
    this.img.style.filter = s.thinking ? "brightness(0.85)" : "";
  }
}

/** Builds the avatar a character asks for. Async because Live2D models load over the network. */
export async function createAvatar(container, avatarConfig, options) {
  if (avatarConfig.type === "live2d") {
    const { createLive2DAvatar } = await import("./live2d.js");
    return createLive2DAvatar(container, avatarConfig, options);
  }
  return avatarConfig.type === "png" ? new PngAvatar(container, avatarConfig, options) : new ToasterAvatar(container, avatarConfig, options);
}

/** Crumb's look, used to keep the show running if the configured avatar fails to load. */
export const FALLBACK_AVATAR = { type: "toaster", label: "", bodyColor: "#8FE3CF", accentColor: "#7CF7FF", screenColor: "#141A33" };

/** Finds a toast rating in a line ("Rated: Burnt") so the avatar can show it. */
export function findRating(text) {
  const match = /\brated:?\s*(raw|golden|toasted|burnt|charcoal)\b/i.exec(text || "");
  return match ? match[1].toLowerCase() : null;
}
