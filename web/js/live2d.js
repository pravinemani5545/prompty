// Live2D avatars: rigged 2D anime models (Cubism 3 and newer), the usual VTuber format.
// Drawn with pixi.js + pixi-live2d-display; the Cubism Core runtime comes from Live2D.
// Same API as the other avatars: setEmotion setLevel setTalking setThinking popToast update.

const scripts = new Map();

function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(
      src,
      new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.appendChild(script);
      }),
    );
  }
  return scripts.get(src);
}

const approach = (current, target, rate, dt) => current + (target - current) * Math.min(1, dt * rate);

// Face per emotion, in Live2D's standard parameter IDs. Models built on the
// standard template have these; anything a model lacks is ignored.
const FACE = {
  neutral: {},
  happy: { ParamMouthForm: 1, ParamEyeLSmile: 1, ParamEyeRSmile: 1, ParamCheek: 0.5 },
  excited: { ParamMouthForm: 1, ParamMouthOpenY: 0.3, ParamEyeLSmile: 0.6, ParamEyeRSmile: 0.6, ParamCheek: 0.7, ParamBrowLY: 0.8, ParamBrowRY: 0.8 },
  smug: { ParamMouthForm: 0.7, ParamBrowLY: -0.4, ParamBrowRY: 0.6 },
  surprised: { ParamMouthForm: -0.3, ParamMouthOpenY: 0.4, ParamBrowLY: 1, ParamBrowRY: 1 },
  angry: { ParamMouthForm: -1, ParamBrowLY: -0.7, ParamBrowRY: -0.7, ParamBrowLAngle: -1, ParamBrowRAngle: -1, ParamBrowLForm: -1, ParamBrowRForm: -1 },
  sad: { ParamMouthForm: -1, ParamBrowLY: -0.4, ParamBrowRY: -0.4, ParamBrowLAngle: 1, ParamBrowRAngle: 1 },
  embarrassed: { ParamMouthForm: 0.4, ParamEyeLSmile: 0.6, ParamEyeRSmile: 0.6, ParamCheek: 1 },
};
const FACE_IDS = [...new Set(Object.values(FACE).flatMap((face) => Object.keys(face)))];
// Eye openness, multiplied on top of blinking.
// Smiling eyes on Live2D rigs come from EyeSmile plus partly closed eyes (the happy squint).
const EYES = { neutral: 1, happy: 0.55, excited: 0.75, smug: 0.6, surprised: 1.3, angry: 0.8, sad: 0.8, embarrassed: 0.7 };
// Where she looks (-1..1). Goes through the model's focus controller, so head, body and hair physics follow.
const GAZE = { neutral: [0, 0], happy: [0, 0.15], excited: [0, 0.3], smug: [0.3, 0.2], surprised: [0, 0.35], angry: [0, -0.25], sad: [0, -0.6], embarrassed: [-0.7, -0.35] };
const TILT = { smug: 8, embarrassed: -6, excited: 4 };

export class Live2DAvatar {
  constructor(container, config, options = {}) {
    this.container = container;
    this.config = config;
    this.manual = Boolean(options.manual);
    this.random = Math.random;
    this.s = { t: 0, emotion: "neutral", level: 0, mouth: 0, talking: false, thinking: false, hop: 0, eyes: 1, tilt: 0, wanderX: 0, wanderY: 0, nextWander: 1 };
    this.face = Object.fromEntries(FACE_IDS.map((id) => [id, { value: 0, weight: 0 }]));
  }

  size() {
    const rect = this.container.getBoundingClientRect();
    return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
  }

  async load() {
    const PIXI = window.PIXI;
    const { width, height } = this.size();
    this.app = new PIXI.Application({
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      // Renders (Shorts) drive frames by hand and screenshot the canvas.
      autoStart: !this.manual,
      preserveDrawingBuffer: this.manual,
      resolution: this.manual ? 1 : Math.min(2, window.devicePixelRatio || 1),
    });
    this.app.view.classList.add("avatar-live2d");
    this.container.replaceChildren(this.app.view);
    this.model = await PIXI.live2d.Live2DModel.from(this.config.model, { autoHitTest: false, autoFocus: false, autoUpdate: !this.manual });
    this.app.stage.addChild(this.model);
    this.baseWidth = this.model.width;
    this.baseHeight = this.model.height;
    this.model.internalModel.on("beforeModelUpdate", () => this.apply());
    this.fit();
    if (!this.manual) new ResizeObserver(() => this.fit()).observe(this.container);
  }

  fit() {
    const { width, height } = this.size();
    if (!this.manual) this.app.renderer.resize(width, height);
    const scale = Math.min(width / this.baseWidth, height / this.baseHeight) * this.config.zoom;
    this.model.scale.set(scale);
    this.model.anchor.set(0.5, this.config.focusY);
    this.model.position.set(width / 2, height / 2);
    this.baseY = height / 2;
    this.frameHeight = height;
  }

  /** Runs inside the model update, after motions, blinking and physics, right before drawing. */
  apply() {
    const core = this.model.internalModel.coreModel;
    const s = this.s;
    for (const id of FACE_IDS) {
      const f = this.face[id];
      if (f.weight > 0.001) core.setParameterValueById(id, f.value, f.weight);
    }
    if (Math.abs(s.eyes - 1) > 0.001) {
      core.multiplyParameterValueById("ParamEyeLOpen", s.eyes);
      core.multiplyParameterValueById("ParamEyeROpen", s.eyes);
    }
    if (s.tilt) core.addParameterValueById("ParamAngleZ", s.tilt);
    if (s.mouth > 0.01 || s.talking) {
      core.setParameterValueById(this.config.lipSyncParam, s.mouth);
      core.addParameterValueById("ParamAngleX", Math.sin(s.t * 2.3) * 3 * s.mouth);
      core.addParameterValueById("ParamAngleY", s.mouth * 4);
      core.addParameterValueById("ParamBodyAngleX", Math.sin(s.t * 1.6) * 2 * s.mouth);
    }
  }

  setEmotion(emotion) {
    if (emotion === this.s.emotion) return;
    this.s.emotion = emotion;
    const expressions = this.config.expressions || {};
    const name = expressions[emotion];
    if (name) this.model.expression(name);
    else if (Object.keys(expressions).length > 0) this.model.internalModel.motionManager.expressionManager?.resetExpression();
  }

  setLevel(level) {
    this.s.level = Math.max(0, Math.min(1, level));
  }

  setTalking(on) {
    this.s.talking = on;
  }

  setThinking(on) {
    this.s.thinking = on;
  }

  /** A little hop when a reply starts (the toaster pops toast; she bounces). */
  popToast() {
    this.s.hop = 1;
  }

  update(dt) {
    const s = this.s;
    s.t += dt;
    s.mouth = approach(s.mouth, s.talking ? s.level : 0, 22, dt);

    const target = FACE[s.emotion] || {};
    for (const id of FACE_IDS) {
      const f = this.face[id];
      const goal = target[id];
      f.weight = approach(f.weight, goal === undefined ? 0 : 1, 6, dt);
      if (goal !== undefined) f.value = approach(f.value, goal, 6, dt);
    }
    s.eyes = approach(s.eyes, s.thinking ? 0.9 : EYES[s.emotion] ?? 1, 8, dt);
    s.tilt = approach(s.tilt, TILT[s.emotion] ?? 0, 4, dt);

    s.nextWander -= dt;
    if (s.nextWander <= 0) {
      s.wanderX = (this.random() - 0.5) * 0.5;
      s.wanderY = (this.random() - 0.5) * 0.3;
      s.nextWander = 1.5 + this.random() * 2.5;
    }
    // Thinking: look up and away. Talking: look at the camera. Otherwise: the emotion's gaze plus idle wandering.
    const [gx, gy] = s.thinking ? [0.65, 0.75] : GAZE[s.emotion] || [0, 0];
    const wander = s.talking || s.thinking ? 0 : 1;
    this.model.internalModel.focusController.focus(gx + s.wanderX * wander, gy + s.wanderY * wander);

    s.hop = Math.max(0, s.hop - dt * 2.5);
    this.model.y = this.baseY - Math.sin(s.hop * Math.PI) * this.frameHeight * 0.012;

    if (this.manual) {
      this.model.update(dt * 1000);
      this.app.renderer.render(this.app.stage);
    }
  }
}

export async function createLive2DAvatar(container, config, options) {
  // The Cubism Core has to be loaded before the plugin.
  await loadScript(config.core);
  if (!window.Live2DCubismCore) throw new Error(`Live2D Cubism Core did not load from ${config.core}`);
  // The renderer is built on Cubism Framework 5, which sizes Core 5's memory up front.
  // Core 4 builds don't have (or need) that call; a no-op lets them load older models.
  window.Live2DCubismCore.Memory ??= { initializeAmountOfMemory() {} };
  await loadScript("/vendor/pixi.min.js");
  await loadScript("/vendor/live2d-cubism4.min.js");
  const avatar = new Live2DAvatar(container, config, options);
  await avatar.load();
  return avatar;
}
