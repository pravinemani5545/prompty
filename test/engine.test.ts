import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { MockBrain } from "../src/brain/mock.js";
import { startEngine, type Engine } from "../src/engine.js";
import { crumb, testConfig, waitFor } from "./helpers.js";

let engine: Engine;
let base: string;

before(async () => {
  engine = await startEngine(testConfig(), {
    brain: new MockBrain(crumb(), { latencyMs: 0 }),
    sources: [],
    idleChatter: false,
    timing: { minGapMs: 5, playbackGraceMs: 3000 },
  });
  base = engine.server.url;
});

after(async () => {
  await engine.stop();
});

/** Raw GET that does not normalize the path, to test traversal handling. */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    http
      .get({ host: url.hostname, port: url.port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

describe("engine server", () => {
  test("serves the pages and the character", async () => {
    for (const page of ["/", "/avatar", "/console", "/short"]) {
      const res = await fetch(base + page);
      assert.equal(res.status, 200, page);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    }
    const character = await (await fetch(`${base}/api/character`)).json();
    assert.equal(character.name, "Crumb");
    assert.equal(character.avatar.type, "toaster");
  });

  test("serves only allow-listed browser builds from node_modules", async () => {
    const pixi = await fetch(`${base}/vendor/pixi.min.js`);
    assert.equal(pixi.status, 200);
    assert.match(pixi.headers.get("content-type") ?? "", /javascript/);
    assert.equal((await fetch(`${base}/vendor/live2d-cubism4.min.js`)).status, 200);
    for (const path of ["/vendor/ws/package.json", "/vendor/..%2fpackage.json", "/vendor/obscenity/dist/index.js"]) {
      assert.equal((await rawGet(path)).status, 404, path);
    }
  });

  test("refuses path traversal", async () => {
    for (const path of ["/web/..%2fpackage.json", "/web/%2e%2e/%2e%2e/package.json", `/media/${engine.session.id}/..%2f..%2fmemory.json`, "/assets/..%2fpackage.json"]) {
      const res = await rawGet(path);
      assert.equal(res.status, 404, path);
      assert.ok(!res.body.includes('"name": "ai-vtuber-engine"'), path);
    }
  });

  test("chat in -> speak over WebSocket -> audio served -> playback ack -> logged", { timeout: 15_000 }, async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const messages: Record<string, any>[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => socket.on("open", resolve));
    socket.send(JSON.stringify({ type: "hello", role: "avatar" }));
    await waitFor(() => messages.find((m) => m.type === "character"), 3000, "character");

    const posted = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "streamerbot_user", text: "crumb rate my keyboard?" }),
    });
    assert.equal(posted.status, 202);

    const speak = await waitFor(() => messages.find((m) => m.type === "speak"), 5000, "speak");
    const audio = await fetch(base + speak.utterance.audioUrl);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    assert.ok((await audio.arrayBuffer()).byteLength > 1000);

    socket.send(JSON.stringify({ type: "playback", id: speak.utterance.id, event: "ended" }));
    // The turn has to close well inside the playback timeout (audio length + 3s grace),
    // which proves the avatar's ack ended it rather than the timer.
    const logged = await waitFor(
      () => engine.session.exchanges().find((e) => e.id === speak.utterance.id),
      1500,
      "exchange in session log",
    );
    assert.equal(logged.replyTo?.user, "streamerbot_user");
    socket.close();
  });

  test("control endpoint drives the director", async () => {
    const pause = await fetch(`${base}/api/control`, { method: "POST", body: JSON.stringify({ action: "pause" }) });
    assert.equal(pause.status, 200);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).paused, true);
    await fetch(`${base}/api/control`, { method: "POST", body: JSON.stringify({ action: "resume" }) });
    assert.equal((await (await fetch(`${base}/api/state`)).json()).paused, false);
    const bad = await fetch(`${base}/api/control`, { method: "POST", body: JSON.stringify({ action: "explode" }) });
    assert.equal(bad.status, 400);
    const badChat = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ text: "no user" }) });
    assert.equal(badChat.status, 400);
  });

  test("console clients get state and history on connect", { timeout: 5000 }, async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const messages: Record<string, any>[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => socket.on("open", resolve));
    socket.send(JSON.stringify({ type: "hello", role: "console" }));
    const state = await waitFor(() => messages.find((m) => m.type === "state"), 3000, "state");
    assert.equal(state.state.brain, "mock (offline)");
    await waitFor(() => messages.find((m) => m.type === "history"), 3000, "history");
    socket.close();
  });
});
