import WebSocket from "ws";
import { createLogger, errorMessage } from "../log.js";
import type { ChatEventKind, ChatMessage } from "../types.js";
import { messageId, type ChatSource, type SourceState } from "./source.js";

const log = createLogger("twitch");

export interface IrcMessage {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => ({ s: " ", ":": ";", "\\": "\\", r: "\r", n: "\n" })[c] ?? c);
}

/** Parses one line of Twitch IRC (IRCv3 with tags). */
export function parseIrcLine(line: string): IrcMessage | null {
  let rest = line.trim();
  if (!rest) return null;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    for (const pair of rest.slice(1, space).split(";")) {
      const eq = pair.indexOf("=");
      if (eq === -1) tags[pair] = "";
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(space + 1);
  }
  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }
  let trailing: string | undefined;
  const trailingStart = rest.indexOf(" :");
  if (trailingStart !== -1) {
    trailing = rest.slice(trailingStart + 2);
    rest = rest.slice(0, trailingStart);
  } else if (rest.startsWith(":")) {
    trailing = rest.slice(1);
    rest = "";
  }
  const params = rest.split(" ").filter(Boolean);
  const command = params.shift();
  if (!command) return null;
  if (trailing !== undefined) params.push(trailing);
  return { tags, prefix, command, params };
}

const USERNOTICE_EVENTS: Record<string, ChatEventKind> = {
  sub: "sub",
  resub: "resub",
  subgift: "giftsub",
  submysterygift: "giftsub",
  raid: "raid",
};

/** Turns a PRIVMSG or USERNOTICE into a chat message, or null for everything else. */
export function toChatMessage(irc: IrcMessage, now = Date.now()): ChatMessage | null {
  const login = irc.prefix?.split("!")[0] ?? irc.tags.login ?? "someone";
  const user = irc.tags["display-name"] || login;
  const badges = irc.tags.badges ?? "";
  const common = {
    platform: "twitch" as const,
    user,
    userId: irc.tags["user-id"],
    ts: now,
    badges: {
      broadcaster: badges.includes("broadcaster/"),
      mod: irc.tags.mod === "1" || badges.includes("moderator/"),
      sub: irc.tags.subscriber === "1" || badges.includes("subscriber/"),
      vip: badges.includes("vip/"),
    },
  };

  if (irc.command === "PRIVMSG") {
    let text = irc.params[1] ?? "";
    const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
    if (action) text = action[1] ?? "";
    const bits = Number(irc.tags.bits ?? 0);
    return {
      ...common,
      id: irc.tags.id || messageId("tw"),
      text,
      firstMessage: irc.tags["first-msg"] === "1",
      ...(bits > 0
        ? {
            paid: { amount: bits / 100, currency: "USD", display: `${bits} bits` },
            event: "bits" as const,
            eventText: `${user} cheered ${bits} bits`,
          }
        : {}),
    };
  }

  if (irc.command === "USERNOTICE") {
    const kind = USERNOTICE_EVENTS[irc.tags["msg-id"] ?? ""];
    if (!kind) return null;
    return {
      ...common,
      id: irc.tags.id || messageId("tw"),
      text: irc.params[1] ?? "",
      event: kind,
      eventText: irc.tags["system-msg"] || `${user}: ${kind}`,
    };
  }
  return null;
}

/**
 * Read-only Twitch chat over the official IRC WebSocket. Uses an anonymous
 * "justinfan" login, so no OAuth token or app registration is needed to read.
 */
export class TwitchChat implements ChatSource {
  readonly name: string;
  private currentState: SourceState = "idle";
  private socket: WebSocket | undefined;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly channel: string,
    private readonly url = "wss://irc-ws.chat.twitch.tv:443",
  ) {
    this.name = `twitch #${channel}`;
  }

  get state(): SourceState {
    return this.currentState;
  }

  start(onMessage: (message: ChatMessage) => void): void {
    this.stopped = false;
    this.connect(onMessage);
  }

  private connect(onMessage: (message: ChatMessage) => void): void {
    this.currentState = "connecting";
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on("open", () => {
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      socket.send("PASS SCHMOOPIIE");
      socket.send(`NICK justinfan${Math.floor(10_000 + Math.random() * 80_000)}`);
      socket.send(`JOIN #${this.channel}`);
    });
    socket.on("message", (data) => {
      for (const line of data.toString().split("\r\n")) {
        const irc = parseIrcLine(line);
        if (!irc) continue;
        if (irc.command === "PING") {
          socket.send(`PONG :${irc.params[0] ?? "tmi.twitch.tv"}`);
        } else if (irc.command === "JOIN" || irc.command === "ROOMSTATE") {
          if (this.currentState !== "connected") log.info(`reading chat in #${this.channel}`);
          this.currentState = "connected";
          this.attempts = 0;
        } else if (irc.command === "RECONNECT") {
          socket.close();
        } else {
          const message = toChatMessage(irc);
          if (message) onMessage(message);
        }
      }
    });
    socket.on("error", (error) => {
      this.currentState = "error";
      log.warn(`connection error: ${errorMessage(error)}`);
    });
    socket.on("close", () => {
      if (this.stopped) return;
      this.currentState = "connecting";
      const delay = Math.min(30_000, 1000 * 2 ** this.attempts++);
      log.info(`disconnected, reconnecting in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(onMessage), delay);
    });
  }

  stop(): void {
    this.stopped = true;
    this.currentState = "stopped";
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}
