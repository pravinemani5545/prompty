import fs from "node:fs";
import path from "node:path";

/** Live2D's official sample models, published by Live2D Inc. on GitHub. */
export const LIVE2D_SAMPLES = "https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources";
export const LIVE2D_CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
export const LIVE2D_MODELS: Record<string, string> = { hiyori: "Hiyori", haru: "Haru", mao: "Mao", natori: "Natori" };

/** Every file a .model3.json points at, relative to the model folder. */
export function referencedFiles(model3: Record<string, any>): string[] {
  const refs = model3.FileReferences ?? {};
  const motions = Object.values(refs.Motions ?? {}).flat() as { File?: string; Sound?: string }[];
  const files = [
    refs.Moc,
    ...(refs.Textures ?? []),
    refs.Physics,
    refs.Pose,
    refs.DisplayInfo,
    refs.UserData,
    ...(refs.Expressions ?? []).map((e: { File?: string }) => e.File),
    ...motions.flatMap((m) => [m.File, m.Sound]),
  ].filter((f): f is string => typeof f === "string" && f.length > 0);
  for (const file of files) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error(`refusing unsafe path in model file: ${file}`);
  }
  return [...new Set(files)];
}

/**
 * Local files a Live2D avatar needs that aren't there yet. Only checks paths
 * served from /assets/; remote URLs are the user's business.
 */
export function missingLive2dFiles(rootDir: string, avatar: { model: string; core: string }): string[] {
  const missing: string[] = [];
  for (const url of [avatar.core, avatar.model]) {
    if (!url.startsWith("/assets/")) continue;
    const file = path.join(rootDir, ...url.split("/").filter(Boolean));
    if (!fs.existsSync(file)) missing.push(path.relative(rootDir, file));
  }
  return missing;
}
