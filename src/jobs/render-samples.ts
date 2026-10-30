import { mkdirSync, writeFileSync } from "node:fs";
import { createRenderer } from "../graphics/render.ts";
import { SAMPLE_CARDS } from "../graphics/samples.ts";

/** Writes the sample cards to out/samples/ so the owner can check the Tamil text shaping (Phase 0 exit criterion). */
const outDir = new URL("../../out/samples/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const renderer = await createRenderer();
try {
  for (const { name, input } of SAMPLE_CARDS) {
    const result = await renderer.render(input, new Date());
    if (!result.ok) {
      console.error(`${name}: ${JSON.stringify(result.error)}`);
      process.exitCode = 1;
      continue;
    }
    writeFileSync(new URL(`${name}.jpg`, outDir), result.value.jpeg);
    console.log(`${name}.jpg ${result.value.width}x${result.value.height} ${result.value.jpeg.byteLength} bytes, headline ${result.value.headlinePx}px`);
  }
} finally {
  await renderer.close();
}
