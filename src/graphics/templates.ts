import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Text-only news cards. No third-party photos and no AI-generated imagery (editorial policy §3, §9):
 * the Coimbatore 360 pipeline posts photorealistic AI scenes of real events, which ErodeGlitz does not do.
 */

export const TEMPLATE_VERSION = "card-v1";
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

export type CardTemplate = "news" | "alert" | "correction";

export type CardInput = {
  template: CardTemplate;
  /** Short category label, for example "மின் தடை". */
  categoryTa: string;
  /** Place tag, for example "ஈரோடு" or "பெருந்துறை". */
  placeTa: string;
  headlineTa: string;
  /** Up to three short fact lines. */
  points: readonly string[];
  /** Already formatted, for example "30 அக்டோபர் 2026". */
  dateTa: string;
  /** For example "தகவல்: மாவட்ட நிர்வாகம்". */
  sourceCreditTa: string;
};

export const CardInputSchema = z.strictObject({
  template: z.enum(["news", "alert", "correction"]),
  categoryTa: z.string().min(1).max(30),
  placeTa: z.string().min(1).max(40),
  headlineTa: z.string().min(1).max(120),
  points: z.array(z.string().min(1).max(90)).max(3).readonly(),
  dateTa: z.string().min(1).max(40),
  sourceCreditTa: z.string().min(1).max(80),
}) satisfies z.ZodType<CardInput>;

const FONT_DIR = new URL("../../assets/fonts/", import.meta.url);

let fontCss: string | undefined;

/** Fonts are embedded as data URLs so rendering never depends on system fonts or file:// access. */
const bundledFontCss = (): string => {
  if (fontCss !== undefined) return fontCss;
  const face = (family: string, file: string): string => {
    const data = readFileSync(fileURLToPath(new URL(file, FONT_DIR))).toString("base64");
    return `@font-face{font-family:"${family}";src:url(data:font/ttf;base64,${data}) format("truetype");font-weight:100 900;font-display:block;}`;
  };
  fontCss = face("EG Tamil", "NotoSansTamil.ttf") + face("EG Latin", "NotoSans.ttf");
  return fontCss;
};

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

type Palette = { bg1: string; bg2: string; accent: string; chipText: string };

const palette = (template: CardTemplate): Palette => {
  switch (template) {
    case "news":
      return { bg1: "#0d1b2a", bg2: "#1b3a4b", accent: "#f2b705", chipText: "#0d1b2a" };
    case "alert":
      return { bg1: "#3b0d0c", bg2: "#7a1f12", accent: "#ffd166", chipText: "#3b0d0c" };
    case "correction":
      return { bg1: "#1f1f1f", bg2: "#3a3a3a", accent: "#ffffff", chipText: "#1f1f1f" };
  }
};

/**
 * Headline size steps down from max to min until it fits in 4 lines. The renderer calls `__runFit()` after
 * `document.fonts.ready`, because line breaks depend on the loaded font.
 */
const FIT_SCRIPT = `
window.__runFit = () => {
  const fit = (el, maxLines, maxPx, minPx) => {
    el.style.maxHeight = "none";
    for (let px = maxPx; px >= minPx; px -= 2) {
      el.style.fontSize = px + "px";
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      if (el.scrollHeight <= Math.ceil(lineHeight * maxLines) + 1) return { ok: true, px };
    }
    return { ok: false, px: minPx };
  };
  const headline = fit(document.getElementById("headline"), 4, 84, 52);
  const points = document.getElementById("points");
  const pointsOk = points.scrollHeight <= points.clientHeight + 1;
  return { headlineOk: headline.ok, headlinePx: headline.px, pointsOk };
};
`;

export const cardHtml = (input: CardInput): string => {
  const p = palette(input.template);
  const points = input.points.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  return `<!doctype html>
<html lang="ta"><head><meta charset="utf-8">
<style>
${bundledFontCss()}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden}
body{font-family:"EG Tamil","EG Latin";color:#fff;background:linear-gradient(160deg,${p.bg1} 0%,${p.bg2} 100%);
  display:flex;flex-direction:column;padding:72px 72px 56px}
.top{display:flex;justify-content:space-between;align-items:center;gap:24px}
.chip{background:${p.accent};color:${p.chipText};font-weight:700;font-size:38px;line-height:1.5;padding:6px 26px;border-radius:999px;white-space:nowrap}
.place{font-weight:600;font-size:38px;line-height:1.5;color:${p.accent};white-space:nowrap}
.rule{height:6px;width:140px;background:${p.accent};border-radius:3px;margin:56px 0 40px}
#headline{font-weight:800;font-size:84px;line-height:1.38;overflow-wrap:break-word}
#points{list-style:none;margin-top:44px;flex:1;overflow:hidden}
#points li{font-weight:500;font-size:40px;line-height:1.5;padding-left:40px;position:relative;margin-bottom:18px}
#points li::before{content:"";position:absolute;left:0;top:0.62em;width:16px;height:16px;border-radius:50%;background:${p.accent}}
.foot{border-top:2px solid rgba(255,255,255,0.25);padding-top:28px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px}
.meta{font-size:32px;line-height:1.5;font-weight:500;opacity:0.92}
.brand{font-family:"EG Latin";font-weight:800;font-size:46px;letter-spacing:0.5px;color:${p.accent};white-space:nowrap}
</style></head>
<body>
<div class="top"><span class="chip">${escapeHtml(input.categoryTa)}</span><span class="place">${escapeHtml(input.placeTa)}</span></div>
<div class="rule"></div>
<h1 id="headline">${escapeHtml(input.headlineTa)}</h1>
<ul id="points">${points}</ul>
<div class="foot"><div class="meta">${escapeHtml(input.dateTa)}<br>${escapeHtml(input.sourceCreditTa)}</div><div class="brand">ErodeGlitz</div></div>
<script>${FIT_SCRIPT}</script>
</body></html>`;
};
