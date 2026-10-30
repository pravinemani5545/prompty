import path from "node:path";
import { BudgetedBrain, type Brain } from "./brain/brain.js";
import { ClaudeBrain } from "./brain/claude.js";
import { MockBrain } from "./brain/mock.js";
import { loadCharacter, type Character } from "./character.js";
import { DemoChat } from "./chat/demo.js";
import type { ChatSource } from "./chat/source.js";
import { TwitchChat } from "./chat/twitch.js";
import { YouTubeChat } from "./chat/youtube.js";
import type { Config } from "./config.js";
import { Director, type DirectorTiming } from "./director.js";
import { createLogger } from "./log.js";
import { Memory } from "./memory.js";
import { Safety } from "./safety.js";
import { startServer, type RunningServer } from "./server.js";
import { Session } from "./session.js";
import { createVoice, type Voice } from "./voice/voices.js";

const log = createLogger("engine");

export interface EngineOptions {
  /** Add the fake demo audience as a chat source. */
  demo?: boolean;
  /** Overrides for tests. */
  brain?: Brain;
  voice?: Voice | null;
  sources?: ChatSource[];
  timing?: Partial<DirectorTiming>;
  idleChatter?: boolean;
}

export interface Engine {
  config: Config;
  character: Character;
  director: Director;
  session: Session;
  server: RunningServer;
  sources: ChatSource[];
  stop(): Promise<void>;
}

export function createBrain(config: Config, character: Character): Brain {
  const mock = new MockBrain(character);
  if (config.brain !== "claude") return mock;
  const claude = new ClaudeBrain(character, {
    model: config.claudeModel,
    effortLive: config.effortLive,
    effortScripts: config.effortScripts,
  });
  return new BudgetedBrain(claude, mock, config.dailyBudgetUsd, (spent) =>
    log.warn(`estimated spend $${spent.toFixed(2)} reached DAILY_BUDGET_USD; switching to the offline brain for this run`),
  );
}

export function createSources(config: Config, character: Character, demo: boolean): ChatSource[] {
  const sources: ChatSource[] = [];
  if (demo) sources.push(new DemoChat({ characterName: character.name }));
  if (config.twitchChannel) sources.push(new TwitchChat(config.twitchChannel));
  if (config.youtube.videoId) {
    sources.push(
      new YouTubeChat({
        videoId: config.youtube.videoId,
        apiKey: config.youtube.apiKey,
        oauthToken: config.youtube.oauthToken,
        minPollSeconds: config.youtube.minPollSeconds,
      }),
    );
  }
  return sources;
}

export async function startEngine(config: Config, options: EngineOptions = {}): Promise<Engine> {
  const character = loadCharacter(config.characterFile);
  const brain = options.brain ?? createBrain(config, character);
  const voice = options.voice === undefined ? createVoice(config, character) : options.voice;
  const safety = new Safety({
    allowProfanity: character.allowProfanity,
    blockedTerms: character.blockedTerms,
    maxReplyChars: character.maxReplyChars,
  });
  const memory = new Memory(path.join(config.dataDir, "memory.json"));
  const session = Session.create(config.dataDir);
  const director = new Director({
    character,
    brain,
    voice,
    safety,
    memory,
    session,
    reviewMode: config.reviewMode,
    idleChatter: options.idleChatter,
    timing: options.timing,
  });
  const sources = options.sources ?? createSources(config, character, options.demo ?? false);
  const server = await startServer({
    character,
    director,
    session,
    sources,
    dataDir: config.dataDir,
    webDir: path.join(config.rootDir, "web"),
    assetsDir: path.join(config.rootDir, "assets"),
    modulesDir: path.join(config.rootDir, "node_modules"),
    host: config.host,
    port: config.port,
    ingestToken: config.ingestToken,
  });
  for (const source of sources) source.start((message) => director.ingest(message));
  director.start();

  return {
    config,
    character,
    director,
    session,
    server,
    sources,
    stop: async () => {
      for (const source of sources) source.stop();
      await director.stop();
      await server.close();
    },
  };
}
