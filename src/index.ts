import path from "node:path";
import { loadConfig, loadDotEnv } from "./config.js";
import { startEngine } from "./engine.js";
import { createLogger, errorMessage } from "./log.js";

const log = createLogger("main");

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const demo = process.argv.includes("--demo");
  const engine = await startEngine(config, { demo });
  const status = engine.director.status();
  const { url } = engine.server;

  console.log(`
  ${engine.character.name} is live.

  Avatar (OBS browser source, 1080x1080): ${url}/avatar
  Operator console:                       ${url}/console

  Brain:   ${status.brain}${config.brain === "mock" ? "   <- set ANTHROPIC_API_KEY in .env for real replies" : ""}
  Voice:   ${status.voice}
  Chat:    ${engine.sources.map((s) => s.name).join(", ") || "none yet (type in the console, or set TWITCH_CHANNEL)"}
  Session: ${path.relative(process.cwd(), engine.session.dir) || engine.session.dir}

  Ctrl+C to stop.
`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down...");
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log.error(errorMessage(error));
  process.exit(1);
});
