import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";
import { WebSocketServer } from "ws";
import { TwitchChat, parseIrcLine, toChatMessage } from "../src/chat/twitch.js";
import type { ChatMessage } from "../src/types.js";
import { waitFor } from "./helpers.js";

describe("Twitch IRC parsing", () => {
  test("reads a tagged PRIVMSG with bits", () => {
    const line =
      "@badge-info=;badges=subscriber/12,premium/1;bits=100;color=#FF0000;display-name=Cool\\sGuy;first-msg=1;id=abc;mod=0;subscriber=1;user-id=123 :coolguy!coolguy@coolguy.tmi.twitch.tv PRIVMSG #crumb :Cheer100 roast me";
    const message = toChatMessage(parseIrcLine(line)!);
    assert.ok(message);
    assert.equal(message.user, "Cool Guy");
    assert.equal(message.text, "Cheer100 roast me");
    assert.equal(message.firstMessage, true);
    assert.equal(message.badges.sub, true);
    assert.equal(message.badges.mod, false);
    assert.equal(message.event, "bits");
    assert.deepEqual(message.paid, { amount: 1, currency: "USD", display: "100 bits" });
  });

  test("unwraps /me actions", () => {
    const message = toChatMessage(parseIrcLine(":a!a@a.tmi.twitch.tv PRIVMSG #c :\u0001ACTION waves\u0001")!);
    assert.equal(message?.text, "waves");
    assert.equal(message?.user, "a");
  });

  test("turns resubs into events and ignores unrelated notices", () => {
    const resub = toChatMessage(
      parseIrcLine("@display-name=Bob;msg-id=resub;system-msg=Bob\\ssubscribed\\sfor\\s3\\smonths! :tmi.twitch.tv USERNOTICE #crumb :great stream")!,
    );
    assert.equal(resub?.event, "resub");
    assert.equal(resub?.eventText, "Bob subscribed for 3 months!");
    assert.equal(resub?.text, "great stream");
    assert.equal(toChatMessage(parseIrcLine("@msg-id=announcement :tmi.twitch.tv USERNOTICE #crumb :hi")!), null);
  });

  test("parses server commands", () => {
    assert.deepEqual(parseIrcLine("PING :tmi.twitch.tv"), { tags: {}, prefix: undefined, command: "PING", params: ["tmi.twitch.tv"] });
    assert.equal(parseIrcLine(""), null);
  });
});

describe("TwitchChat connection", () => {
  test("logs in anonymously, answers PING and delivers chat", { timeout: 10_000 }, async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const received: string[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const line = data.toString();
        received.push(line);
        if (line.startsWith("JOIN")) {
          socket.send(":justinfan!justinfan@justinfan.tmi.twitch.tv JOIN #crumb\r\nPING :tmi.twitch.tv\r\n");
          socket.send("@display-name=Viewer :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #crumb :hello crumb\r\n");
        }
      });
    });

    const messages: ChatMessage[] = [];
    const chat = new TwitchChat("crumb", `ws://127.0.0.1:${port}`);
    chat.start((m) => messages.push(m));
    try {
      await waitFor(() => messages.length > 0, 5000, "a chat message");
      assert.equal(messages[0]?.text, "hello crumb");
      assert.equal(chat.state, "connected");
      await waitFor(() => received.includes("PONG :tmi.twitch.tv"), 5000, "PONG");
      assert.ok(received.some((l) => /^NICK justinfan\d+$/.test(l)));
      assert.ok(received.includes("JOIN #crumb"));
    } finally {
      chat.stop();
      server.close();
    }
  });
});
