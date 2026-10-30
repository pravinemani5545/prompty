import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT_DIR } from "../config.js";
import { LIVE2D_CORE_URL as CORE_URL, LIVE2D_MODELS as MODELS, LIVE2D_SAMPLES as SAMPLES, referencedFiles } from "../live2d.js";
import { errorMessage } from "../log.js";

const TERMS = `
The Live2D sample models and the Cubism Core runtime are made by Live2D Inc.
They are not part of this project and have their own terms:

  Free Material License Agreement
    https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html
  Terms of Use for Live2D Cubism Sample Data
    https://www.live2d.com/eula/live2d-sample-model-terms_en.html
  Live2D Proprietary Software License Agreement (Cubism Core)
    https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html

In short: individuals and businesses with annual sales under 10 million yen may
use the sample models, including commercially; larger businesses may not. The
characters' designs may not be changed. Read the agreements before you stream.
For a channel you plan to grow, commission your own model: it's your brand.
`;

const HELP = `
Downloads a Live2D sample model and the Cubism Core runtime into assets/live2d/.

  npm run setup:live2d -- --accept                  Hiyori (default)
  npm run setup:live2d -- --accept --model haru     also: mao, natori
  npm run setup:live2d -- --accept --core-file ./live2dcubismcore.min.js
                                                    use a Core you downloaded yourself
`;

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      accept: { type: "boolean" },
      model: { type: "string", default: "hiyori" },
      "core-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  console.log(TERMS);
  if (!values.accept) {
    console.log("Nothing was downloaded. If you agree to those terms, run:\n\n  npm run setup:live2d -- --accept\n");
    return;
  }

  const key = values.model!.toLowerCase();
  const name = MODELS[key];
  if (!name) throw new Error(`unknown model "${values.model}". Choose one of: ${Object.keys(MODELS).join(", ")}`);
  const root = path.join(ROOT_DIR, "assets", "live2d");
  const modelDir = path.join(root, key);
  fs.mkdirSync(modelDir, { recursive: true });

  const corePath = path.join(root, "live2dcubismcore.min.js");
  if (values["core-file"]) {
    fs.copyFileSync(values["core-file"], corePath);
    console.log(`Cubism Core: copied from ${values["core-file"]}`);
  } else {
    try {
      fs.writeFileSync(corePath, await download(CORE_URL));
      console.log("Cubism Core: downloaded");
    } catch (error) {
      console.log(`Cubism Core: could not download (${errorMessage(error)}).`);
      console.log(`  Download it in your browser from ${CORE_URL}`);
      console.log(`  and save it as ${path.relative(process.cwd(), corePath)}`);
    }
  }

  const base = `${SAMPLES}/${name}`;
  const manifestName = `${name}.model3.json`;
  const manifest = await download(`${base}/${manifestName}`);
  fs.writeFileSync(path.join(modelDir, manifestName), manifest);
  const files = referencedFiles(JSON.parse(manifest.toString("utf8")));
  let done = 0;
  for (const file of files) {
    const target = path.join(modelDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await download(`${base}/${file.split("/").map(encodeURIComponent).join("/")}`));
    done += 1;
    process.stdout.write(`\r${name}: ${done}/${files.length} files`);
  }
  process.stdout.write("\n");
  fs.writeFileSync(path.join(root, "LICENSE-NOTICE.txt"), TERMS.trim() + "\n");

  console.log(`
Done. Model: assets/live2d/${key}/${manifestName}
Use it in your character file:

  avatar:
    type: live2d
    model: /assets/live2d/${key}/${manifestName}
`);
}

main().catch((error) => {
  console.error(`setup:live2d: ${errorMessage(error)}`);
  process.exit(1);
});
