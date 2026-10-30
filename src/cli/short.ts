import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadCharacter, type Character } from "../character.js";
import { loadConfig, loadDotEnv, type Config } from "../config.js";
import { createBrain } from "../engine.js";
import { errorMessage } from "../log.js";
import { Session, type SessionExchange } from "../session.js";
import { renderShort, type ShortInput } from "../studio/render.js";
import { isEmotion, type Emotion } from "../types.js";
import { createVoice } from "../voice/voices.js";

const HELP = `
Render vertical (1080x1920) Shorts with the avatar, captions and voice.

From a stream you already did (uses the saved audio, no API calls):
  npm run short -- --starred                 every moment you starred in the console
  npm run short -- --clipped                 every moment marked with "Mark clip"
  npm run short -- --last 3                  the last 3 things the character said
  npm run short -- --exchange x0012          one specific moment (id from the console)
  add --session <id> to use an older session (default: latest)

Fresh content:
  npm run short -- --topic "tabs vs spaces"  the brain writes a script, then it's voiced and rendered
  npm run short -- --say "Rated: Charcoal." --question "roast my code" --user "chat"

Options:
  --title "..."   on-screen hook text      --out <dir>   output folder (default out/shorts)
  --emotion smug  for --say                --fps 30
`;

interface Job {
  name: string;
  input: Omit<ShortInput, "outFile">;
  caption: string;
  hashtags: string[];
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "short";
}

function defaultHashtags(character: Character): string[] {
  return ["aivtuber", "vtuber", character.name.toLowerCase().replace(/\W+/g, ""), "ai"];
}

function jobsFromSession(values: Record<string, unknown>, config: Config, character: Character): Job[] {
  const session = Session.open(config.dataDir, (values.session as string | undefined) ?? "latest");
  let picked: SessionExchange[] = session.exchanges();
  const ids = values.exchange as string[] | undefined;
  if (ids?.length) picked = picked.filter((e) => ids.includes(e.id));
  else if (values.starred) picked = picked.filter((e) => e.starred);
  else if (values.clipped) picked = picked.filter((e) => e.clipped);
  else if (values.last) picked = picked.slice(-Math.max(1, Number(values.last)));
  if (picked.length === 0) throw new Error(`nothing matched in session ${session.id}`);

  return picked.map((exchange) => {
    const audioPath = exchange.audioFile ? path.join(session.audioDir, exchange.audioFile) : null;
    const fromChat = exchange.replyTo && exchange.kind === "chat";
    return {
      name: `${session.id}-${exchange.id}`,
      input: {
        title: (values.title as string | undefined) ?? (fromChat ? character.shortsTitle : character.name),
        question: fromChat ? { user: exchange.replyTo!.user, text: exchange.replyTo!.text, platform: exchange.replyTo!.platform } : undefined,
        lines: [{ text: exchange.say, emotion: exchange.emotion, audio: audioPath && fs.existsSync(audioPath) ? fs.readFileSync(audioPath) : null }],
      },
      caption: fromChat ? `${exchange.replyTo!.user} asked. ${character.name} answered.` : exchange.say,
      hashtags: defaultHashtags(character),
    };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      session: { type: "string" },
      exchange: { type: "string", multiple: true },
      starred: { type: "boolean" },
      clipped: { type: "boolean" },
      last: { type: "string" },
      topic: { type: "string" },
      say: { type: "string" },
      question: { type: "string" },
      user: { type: "string" },
      emotion: { type: "string" },
      title: { type: "string" },
      out: { type: "string" },
      fps: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const fromSession = Boolean(values.exchange?.length || values.starred || values.clipped || values.last);
  if (values.help || (!fromSession && !values.topic && !values.say)) {
    console.log(HELP);
    return;
  }

  loadDotEnv();
  const config = loadConfig();
  const character = loadCharacter(config.characterFile);
  const outDir = path.resolve(config.rootDir, values.out ?? "out/shorts");
  const voice = createVoice(config, character);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  let jobs: Job[];
  if (fromSession) {
    jobs = jobsFromSession(values, config, character);
  } else if (values.topic) {
    const brain = createBrain(config, character);
    console.log(`Writing a script with ${brain.name}...`);
    const script = await brain.writeShort(values.topic);
    const lines = [];
    for (const line of script.lines) {
      lines.push({ text: line.say, emotion: line.emotion, audio: voice ? (await voice.synthesize(line.say, line.emotion)).data : null });
    }
    jobs = [
      {
        name: `topic-${slug(values.topic)}-${stamp}`,
        input: {
          title: values.title ?? script.title,
          question: script.question ? { ...script.question, platform: "twitch" } : undefined,
          lines,
        },
        caption: script.caption,
        hashtags: script.hashtags.length > 0 ? script.hashtags : defaultHashtags(character),
      },
    ];
  } else {
    const text = values.say!;
    const emotion: Emotion = isEmotion(values.emotion) ? values.emotion : "smug";
    jobs = [
      {
        name: `line-${slug(text)}-${stamp}`,
        input: {
          title: values.title ?? (values.question ? character.shortsTitle : character.name),
          question: values.question ? { user: values.user ?? "chat", text: values.question, platform: "twitch" } : undefined,
          lines: [{ text, emotion, audio: voice ? (await voice.synthesize(text, emotion)).data : null }],
        },
        caption: text,
        hashtags: defaultHashtags(character),
      },
    ];
  }

  for (const job of jobs) {
    const outFile = path.join(outDir, `${job.name}.mp4`);
    const started = Date.now();
    const result = await renderShort(
      { ...job.input, outFile },
      {
        rootDir: config.rootDir,
        character,
        ffmpegPath: config.ffmpegPath,
        chromiumPath: config.chromiumPath,
        fps: values.fps ? Number(values.fps) : 30,
        onProgress: (frame, total) => {
          if (frame % 15 === 0 || frame === total) process.stdout.write(`\r  ${job.name}: ${Math.round((frame / total) * 100)}%`);
        },
      },
    );
    fs.writeFileSync(
      outFile.replace(/\.mp4$/, ".txt"),
      `${job.caption}\n\n${job.hashtags.map((t) => `#${t}`).join(" ")}\n`,
    );
    process.stdout.write("\n");
    console.log(`  saved ${path.relative(process.cwd(), result.file)} (${result.durationSec.toFixed(1)}s, rendered in ${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  console.log(`\nPost captions are in the matching .txt files. Review every Short before posting.`);
}

main().catch((error) => {
  console.error(`short: ${errorMessage(error)}`);
  process.exit(1);
});
