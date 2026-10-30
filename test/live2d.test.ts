import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { ratingScale } from "../src/brain/mock.js";
import { loadCharacter, parseCharacter } from "../src/character.js";
import { ROOT_DIR } from "../src/config.js";
import { missingLive2dFiles, referencedFiles } from "../src/live2d.js";
import { crumb, tempDir } from "./helpers.js";

const base = fs.readFileSync(path.join(ROOT_DIR, "characters", "crumb.yaml"), "utf8").replace(/^avatar:[\s\S]*?(?=^voice:)/m, "");

describe("Live2D character config", () => {
  test("the default character, Kiko, is a Live2D avatar with sensible defaults", () => {
    const kiko = loadCharacter(path.join(ROOT_DIR, "characters", "kiko.yaml"));
    assert.equal(kiko.avatar.type, "live2d");
    if (kiko.avatar.type !== "live2d") return;
    assert.equal(kiko.avatar.model, "/assets/live2d/hiyori/Hiyori.model3.json");
    assert.equal(kiko.avatar.core, "/assets/live2d/live2dcubismcore.min.js");
    assert.equal(kiko.avatar.lipSyncParam, "ParamMouthOpenY");
  });

  test("validates the model path, numbers and expression mapping", () => {
    const parse = (avatar: string) => parseCharacter(`${base}\navatar:\n${avatar}`);
    const ok = parse("  type: live2d\n  model: /assets/m/M.model3.json\n  zoom: 2\n  expressions:\n    happy: F01\n");
    assert.deepEqual(ok.avatar, {
      type: "live2d",
      model: "/assets/m/M.model3.json",
      core: "/assets/live2d/live2dcubismcore.min.js",
      zoom: 2,
      focusY: 0.33,
      lipSyncParam: "ParamMouthOpenY",
      expressions: { happy: "F01" },
    });
    assert.throws(() => parse("  type: live2d\n  model: /assets/m/model.json\n"), /\.model3\.json/);
    assert.throws(() => parse("  type: live2d\n  model: /assets/m/M.model3.json\n  zoom: 99\n"), /zoom/);
    assert.throws(() => parse("  type: live2d\n  model: /assets/m/M.model3.json\n  expressions:\n    furious: F02\n"), /expressions/);
  });
});

describe("Live2D setup helpers", () => {
  test("finds every file a model references, once", () => {
    const files = referencedFiles({
      FileReferences: {
        Moc: "M.moc3",
        Textures: ["M.2048/texture_00.png"],
        Physics: "M.physics3.json",
        Expressions: [{ Name: "F01", File: "exp/F01.exp3.json" }],
        Motions: { Idle: [{ File: "motions/idle.motion3.json" }, { File: "motions/idle.motion3.json", Sound: "s.wav" }] },
      },
    });
    assert.deepEqual(files, ["M.moc3", "M.2048/texture_00.png", "M.physics3.json", "exp/F01.exp3.json", "motions/idle.motion3.json", "s.wav"]);
  });

  test("refuses model files that point outside the model folder", () => {
    assert.throws(() => referencedFiles({ FileReferences: { Moc: "../../evil.js" } }), /unsafe/);
    assert.throws(() => referencedFiles({ FileReferences: { Textures: ["/etc/passwd"] } }), /unsafe/);
  });

  test("reports which local files are missing", () => {
    const root = tempDir();
    const avatar = { model: "/assets/live2d/x/X.model3.json", core: "/assets/live2d/core.js" };
    assert.deepEqual(missingLive2dFiles(root, avatar), [path.join("assets", "live2d", "core.js"), path.join("assets", "live2d", "x", "X.model3.json")]);
    fs.mkdirSync(path.join(root, "assets", "live2d", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets", "live2d", "core.js"), "");
    fs.writeFileSync(path.join(root, "assets", "live2d", "x", "X.model3.json"), "{}");
    assert.deepEqual(missingLive2dFiles(root, avatar), []);
    assert.deepEqual(missingLive2dFiles(root, { model: "https://cdn.example/M.model3.json", core: "https://cdn.example/core.js" }), []);
  });
});

describe("offline brain rating scales", () => {
  test("reads each character's own scale from its recurring bits", () => {
    assert.deepEqual(ratingScale(crumb()), { label: "Rated", values: ["Raw", "Golden", "Toasted", "Burnt", "Charcoal"] });
    const kiko = loadCharacter(path.join(ROOT_DIR, "characters", "kiko.yaml"));
    assert.deepEqual(ratingScale(kiko), { label: "Verdict", values: ["Approved", "Patched", "Deprecated", "Deleted"] });
  });
});
