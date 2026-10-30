import fs from "node:fs";
import path from "node:path";
import type { Platform } from "./types.js";

export interface ViewerRecord {
  name: string;
  platform: Platform;
  firstSeen: string;
  lastSeen: string;
  messages: number;
  replies: number;
  notes: string[];
}

interface MemoryFile {
  version: 1;
  viewers: Record<string, ViewerRecord>;
  lore: string[];
}

const MAX_NOTES_PER_VIEWER = 6;
const MAX_LORE = 25;

/**
 * Long-term memory across streams: who the regulars are, what Crumb learned
 * about them, and running bits. Stored as a small JSON file.
 */
export class Memory {
  private data: MemoryFile = { version: 1, viewers: {}, lore: [] };
  private saveTimer: NodeJS.Timeout | undefined;

  /** Pass `null` for an in-memory store (tests, renders). */
  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MemoryFile>;
      this.data = { version: 1, viewers: parsed.viewers ?? {}, lore: parsed.lore ?? [] };
    }
  }

  static key(platform: Platform, user: string): string {
    return `${platform}:${user.toLowerCase()}`;
  }

  /** Records that a viewer sent a message. */
  touch(platform: Platform, user: string, now = new Date()): ViewerRecord {
    const key = Memory.key(platform, user);
    const stamp = now.toISOString();
    const record = (this.data.viewers[key] ??= {
      name: user,
      platform,
      firstSeen: stamp,
      lastSeen: stamp,
      messages: 0,
      replies: 0,
      notes: [],
    });
    record.name = user;
    record.lastSeen = stamp;
    record.messages += 1;
    this.scheduleSave();
    return record;
  }

  recordReply(platform: Platform, user: string): void {
    const record = this.data.viewers[Memory.key(platform, user)];
    if (record) {
      record.replies += 1;
      this.scheduleSave();
    }
  }

  viewer(platform: Platform, user: string): ViewerRecord | undefined {
    return this.data.viewers[Memory.key(platform, user)];
  }

  isRegular(platform: Platform, user: string): boolean {
    const record = this.viewer(platform, user);
    return Boolean(record && (record.messages >= 5 || record.replies >= 2));
  }

  /** What to tell the brain about a viewer. */
  notesFor(platform: Platform, user: string): string[] {
    const record = this.viewer(platform, user);
    if (!record) return [];
    const notes = [...record.notes];
    if (record.messages > 1) {
      notes.unshift(`Has chatted ${record.messages} times since ${record.firstSeen.slice(0, 10)}.`);
    }
    return notes;
  }

  lore(): string[] {
    return [...this.data.lore];
  }

  /** Stores a note about a viewer, or a running bit when no viewer is given. */
  remember(note: string, about?: { platform: Platform; user: string }): void {
    const clean = note.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!clean) return;
    const list = about ? this.viewer(about.platform, about.user)?.notes : this.data.lore;
    if (!list) return;
    if (list.some((existing) => existing.toLowerCase() === clean.toLowerCase())) return;
    list.push(clean);
    const max = about ? MAX_NOTES_PER_VIEWER : MAX_LORE;
    if (list.length > max) list.splice(0, list.length - max);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
    this.saveTimer.unref();
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
