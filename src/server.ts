import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { publicCharacter, type Character } from "./character.js";
import type { ChatSource } from "./chat/source.js";
import { messageId } from "./chat/source.js";
import type { Director } from "./director.js";
import { createLogger, errorMessage, logEvents, type LogEntry } from "./log.js";
import type { Session } from "./session.js";
import { isEmotion, type ChatMessage, type Platform } from "./types.js";

const log = createLogger("server");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
};

/** Serves files under `dir` for a request path below a mount point, refusing anything that escapes it. */
export function serveFile(res: http.ServerResponse, dir: string, relative: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return false;
  }
  const root = path.resolve(dir);
  const full = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

export interface StaticMounts {
  webDir: string;
  assetsDir: string;
  /** node_modules, for the few browser builds listed in VENDOR. */
  modulesDir: string;
}

/** Browser builds the avatar pages load from /vendor/<name>. Nothing else in node_modules is exposed. */
const VENDOR: Record<string, string> = {
  "pixi.min.js": "pixi.js/dist/pixi.min.js",
  "live2d-cubism4.min.js": "pixi-live2d-display-lipsyncpatch/dist/cubism4.min.js",
};

/** Routes shared by the live server and the Shorts renderer: pages, scripts and assets. */
export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, mounts: StaticMounts): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pages: Record<string, string> = {
    "/": "index.html",
    "/avatar": "avatar.html",
    "/console": "console.html",
    "/short": "short.html",
  };
  const page = pages[url.pathname];
  if (page) return serveFile(res, mounts.webDir, page);
  if (url.pathname.startsWith("/web/")) return serveFile(res, mounts.webDir, url.pathname.slice("/web/".length));
  if (url.pathname.startsWith("/assets/")) return serveFile(res, mounts.assetsDir, url.pathname.slice("/assets/".length));
  const vendored = url.pathname.startsWith("/vendor/") ? VENDOR[url.pathname.slice("/vendor/".length)] : undefined;
  if (vendored) return serveFile(res, mounts.modulesDir, vendored);
  return false;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage, limit = 32_000): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
  return parsed as Record<string, unknown>;
}

export interface ServerDeps extends StaticMounts {
  character: Character;
  director: Director;
  session: Session;
  sources: ChatSource[];
  dataDir: string;
  host: string;
  port: number;
  ingestToken?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

type ClientRole = "avatar" | "console";

/**
 * Applies one operator command. Shared by the console WebSocket and POST /api/control
 * (so a Stream Deck or Streamer.bot button can trigger the same actions).
 */
export function applyControl(director: Director, command: Record<string, unknown>): string | null {
  const text = typeof command.text === "string" ? command.text : "";
  const id = typeof command.id === "string" ? command.id : "";
  switch (command.action) {
    case "pause":
      director.pause();
      return null;
    case "resume":
      director.resume();
      return null;
    case "skip":
      director.skip();
      return null;
    case "clip":
      director.markClip("manual");
      return null;
    case "idle":
      director.setIdleChatter(command.value === true);
      return null;
    case "review":
      director.setReviewMode(command.value === true);
      return null;
    case "handler":
      director.handler(text);
      return null;
    case "say":
      director.say(text, isEmotion(command.emotion) ? command.emotion : "neutral");
      return null;
    case "emotion":
      if (!isEmotion(command.emotion)) return "unknown emotion";
      director.setEmotion(command.emotion);
      return null;
    case "approve":
      director.approve(id);
      return null;
    case "reject":
      director.reject(id);
      return null;
    case "star":
      director.star(id);
      return null;
    default:
      return `unknown action "${String(command.action)}"`;
  }
}

/** Builds a chat message from an outside integration (Streamer.bot, Social Stream Ninja, a test). */
export function messageFromJson(body: Record<string, unknown>): ChatMessage | string {
  const user = typeof body.user === "string" ? body.user.trim().slice(0, 40) : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!user) return "user is required";
  const platform: Platform = body.platform === "console" ? "console" : "http";
  const amount = Number(body.amount);
  return {
    id: messageId("http"),
    platform,
    user,
    text,
    ts: Date.now(),
    badges: { sub: body.sub === true, mod: body.mod === true },
    ...(Number.isFinite(amount) && amount > 0
      ? { paid: { amount, currency: String(body.currency ?? "USD"), display: String(body.display ?? `$${amount}`) }, event: "superchat" as const }
      : {}),
  };
}

export async function startServer(deps: ServerDeps): Promise<RunningServer> {
  const { director, session, sources, character } = deps;
  const clients = new Map<WebSocket, ClientRole | null>();
  const recentLogs: LogEntry[] = [];

  const broadcast = (role: ClientRole | "all", payload: unknown) => {
    const data = JSON.stringify(payload);
    for (const [socket, clientRole] of clients) {
      if (socket.readyState === socket.OPEN && (role === "all" || clientRole === role)) socket.send(data);
    }
  };
  const fullState = () => ({
    ...director.status(),
    sources: sources.map((s) => ({ name: s.name, state: s.state })),
  });

  const forwards: [string, (...args: unknown[]) => void][] = [
    ["speak", (u) => broadcast("all", { type: "speak", utterance: u })],
    ["stop", () => broadcast("all", { type: "stop" })],
    ["thinking", (on) => broadcast("all", { type: "thinking", on })],
    ["emotion", (emotion) => broadcast("all", { type: "emotion", emotion })],
    ["chat", (payload) => broadcast("console", { type: "chat", ...(payload as object) })],
    ["pending", (u) => broadcast("console", { type: "pending", utterance: u })],
    ["reviewed", (payload) => broadcast("console", { type: "reviewed", ...(payload as object) })],
    ["exchange", (entry) => broadcast("console", { type: "exchange", entry })],
    ["clip", (payload) => broadcast("console", { type: "clip", ...(payload as object) })],
    ["star", (exchangeId) => broadcast("console", { type: "star", exchangeId })],
    ["alert", (payload) => broadcast("console", { type: "alert", ...(payload as object) })],
    ["state", () => broadcast("console", { type: "state", state: fullState() })],
  ];
  for (const [event, handler] of forwards) director.on(event, handler);
  const onLog = (entry: LogEntry) => {
    recentLogs.push(entry);
    if (recentLogs.length > 100) recentLogs.shift();
    broadcast("console", { type: "log", entry });
  };
  logEvents.on("log", onLog);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && serveStatic(req, res, deps)) return;

      if (req.method === "GET" && url.pathname.startsWith("/media/")) {
        const [, , sessionId, file] = url.pathname.split("/");
        if (sessionId && file && /^[\w-]+$/.test(sessionId)) {
          if (serveFile(res, path.join(deps.dataDir, "sessions", sessionId, "audio"), file)) return;
        }
        return sendJson(res, 404, { error: "not found" });
      }
      if (req.method === "GET" && url.pathname === "/api/character") return sendJson(res, 200, publicCharacter(character));
      if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, fullState());
      if (req.method === "GET" && url.pathname === "/api/exchanges") return sendJson(res, 200, session.exchanges().slice(-50));

      if (req.method === "POST" && (url.pathname === "/api/chat" || url.pathname === "/api/control")) {
        if (deps.ingestToken && req.headers.authorization !== `Bearer ${deps.ingestToken}`) {
          return sendJson(res, 401, { error: "missing or wrong INGEST_TOKEN" });
        }
        const body = await readJson(req);
        if (url.pathname === "/api/chat") {
          const message = messageFromJson(body);
          if (typeof message === "string") return sendJson(res, 400, { error: message });
          director.ingest(message);
          return sendJson(res, 202, { ok: true, id: message.id });
        }
        const error = applyControl(director, body);
        return error ? sendJson(res, 400, { error }) : sendJson(res, 200, { ok: true });
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 400, { error: errorMessage(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket: WebSocket) => {
    clients.set(socket, null);
    socket.on("close", () => clients.delete(socket));
    socket.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === "hello") {
        const role: ClientRole = message.role === "console" ? "console" : "avatar";
        clients.set(socket, role);
        socket.send(JSON.stringify({ type: "character", character: publicCharacter(character) }));
        if (role === "console") {
          socket.send(JSON.stringify({ type: "state", state: fullState() }));
          socket.send(JSON.stringify({ type: "history", exchanges: session.exchanges().slice(-30), logs: recentLogs }));
        }
        return;
      }
      if (message.type === "playback" && message.event === "ended" && typeof message.id === "string") {
        director.playbackEnded(message.id);
        return;
      }
      if (clients.get(socket) !== "console") return;
      if (message.type === "chat") {
        const chat = messageFromJson({ ...message, platform: "console" });
        if (typeof chat !== "string") director.ingest(chat);
        return;
      }
      if (message.type === "control") {
        const error = applyControl(director, message);
        if (error) socket.send(JSON.stringify({ type: "error", error }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : deps.port;
  const displayHost = deps.host === "0.0.0.0" ? "localhost" : deps.host;
  const url = `http://${displayHost}:${port}`;
  log.debug(`listening on ${url}`);

  return {
    url,
    port,
    close: async () => {
      for (const [event, handler] of forwards) director.off(event, handler);
      logEvents.off("log", onLog);
      for (const socket of clients.keys()) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
