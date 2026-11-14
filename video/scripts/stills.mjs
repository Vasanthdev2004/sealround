// Renders review stills: node scripts/stills.mjs 100 400 ...  (frames) into out/review/
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frames = process.argv.slice(2).map(Number);
const serveUrl = await bundle({ entryPoint: join(here, "../src/index.ts") });
const composition = await selectComposition({ serveUrl, id: "Launch" });
for (const frame of frames) {
  const output = join(here, `../out/review/f${String(frame).padStart(4, "0")}.png`);
  await renderStill({ composition, serveUrl, output, frame, scale: 0.5 });
  console.log("still", frame);
}
