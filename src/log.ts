import { EventEmitter } from "node:events";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  scope: string;
  message: string;
  ts: number;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Log lines also go out as events so the operator console can show them live. */
export const logEvents = new EventEmitter();

let threshold: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string) => {
    if (ORDER[level] < ORDER[threshold]) return;
    const entry: LogEntry = { level, scope, message, ts: Date.now() };
    const time = new Date(entry.ts).toISOString().slice(11, 19);
    const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
    logEvents.emit("log", entry);
  };
  return {
    debug: (m) => write("debug", m),
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
