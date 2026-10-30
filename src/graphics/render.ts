import { createHash } from "node:crypto";
import { chromium, type Browser } from "playwright-core";
import { z } from "zod";
import { err, ok, type Result } from "../lib/result.ts";
import type { Sha256Hex } from "../domain/types.ts";
import { CARD_HEIGHT, CARD_WIDTH, CardInputSchema, TEMPLATE_VERSION, cardHtml, type CardInput } from "./templates.ts";

/** Instagram accepts JPEG up to 8 MB; house limit keeps a wide margin. */
export const MAX_JPEG_BYTES = 2 * 1024 * 1024;

export type RenderedCard = {
  jpeg: Uint8Array;
  jpegSha256: Sha256Hex;
  /** Content-addressed, ASCII-only object key (Meta warns that non-ASCII image URLs can fail). */
  objectKey: string;
  width: number;
  height: number;
  headlinePx: number;
};

export type RenderError =
  | { kind: "invalid_input"; message: string }
  | { kind: "text_overflow"; field: "headline" | "points" }
  | { kind: "font_not_loaded" }
  | { kind: "bad_output"; message: string };

const FitResultSchema = z.object({ headlineOk: z.boolean(), headlinePx: z.number(), pointsOk: z.boolean() });

const sha256Hex = (data: Uint8Array | string): Sha256Hex => createHash("sha256").update(data).digest("hex") as Sha256Hex;

/** Reads width and height from the first SOFn marker of a baseline or progressive JPEG. */
export const jpegDimensions = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1] ?? 0;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return { width, height };
    }
    i += 2 + length;
  }
  return undefined;
};

export const renderObjectKey = (input: CardInput, now: Date): string => {
  const inputHash = sha256Hex(JSON.stringify({ templateVersion: TEMPLATE_VERSION, input }));
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `renders/${yyyy}/${mm}/${inputHash}.jpg`;
};

export type Renderer = {
  render: (input: CardInput, now: Date) => Promise<Result<RenderedCard, RenderError>>;
  close: () => Promise<void>;
};

/**
 * Starts headless Chromium once per job. `executablePath` overrides the browser that
 * `playwright-core install chromium-headless-shell` placed in the Playwright cache.
 */
export const createRenderer = async (options: { executablePath?: string } = {}): Promise<Renderer> => {
  const browser: Browser = await chromium.launch(
    options.executablePath === undefined ? {} : { executablePath: options.executablePath },
  );

  const render = async (rawInput: CardInput, now: Date): Promise<Result<RenderedCard, RenderError>> => {
    const parsed = CardInputSchema.safeParse(rawInput);
    if (!parsed.success) return err({ kind: "invalid_input", message: parsed.error.message });
    const input = parsed.data;

    const page = await browser.newPage({ viewport: { width: CARD_WIDTH, height: CARD_HEIGHT }, deviceScaleFactor: 1 });
    try {
      // The page needs no network: fonts are embedded and there are no external resources.
      await page.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
      await page.setContent(cardHtml(input), { waitUntil: "load" });
      const fontsOk = await page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check('800 64px "EG Tamil"', "ஈரோடு") && document.fonts.check('800 46px "EG Latin"', "ErodeGlitz");
      });
      if (!fontsOk) return err({ kind: "font_not_loaded" });

      const fit = FitResultSchema.parse(
        await page.evaluate(() => (window as unknown as { __runFit: () => unknown }).__runFit()),
      );
      if (!fit.headlineOk) return err({ kind: "text_overflow", field: "headline" });
      if (!fit.pointsOk) return err({ kind: "text_overflow", field: "points" });

      const jpeg = new Uint8Array(await page.screenshot({ type: "jpeg", quality: 85, fullPage: false }));
      const dims = jpegDimensions(jpeg);
      if (dims?.width !== CARD_WIDTH || dims.height !== CARD_HEIGHT) {
        return err({ kind: "bad_output", message: `unexpected dimensions ${JSON.stringify(dims)}` });
      }
      if (jpeg.byteLength > MAX_JPEG_BYTES) {
        return err({ kind: "bad_output", message: `JPEG too large: ${jpeg.byteLength} bytes` });
      }
      return ok({
        jpeg,
        jpegSha256: sha256Hex(jpeg),
        objectKey: renderObjectKey(input, now),
        width: dims.width,
        height: dims.height,
        headlinePx: fit.headlinePx,
      });
    } finally {
      await page.close();
    }
  };

  return { render, close: () => browser.close() };
};
