import { afterAll, describe, expect, it } from "vitest";
import { createRenderer, jpegDimensions, renderObjectKey, type Renderer } from "./render.ts";
import { SAMPLE_CARDS } from "./samples.ts";
import { cardHtml, type CardInput } from "./templates.ts";

/** Rendering tests run only where the Chromium headless shell is installed (`playwright-core install chromium-headless-shell`). */
const launched: Renderer | undefined = await createRenderer().catch(() => undefined);
const sample = SAMPLE_CARDS[0]?.input;
if (sample === undefined) throw new Error("no sample card");

describe("cardHtml", () => {
  it("escapes untrusted text", () => {
    const html = cardHtml({ ...sample, headlineTa: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("renderObjectKey", () => {
  it("is ASCII, content addressed and stable", () => {
    const now = new Date("2026-10-30T06:00:00Z");
    const a = renderObjectKey(sample, now);
    expect(a).toMatch(/^renders\/2026\/10\/[0-9a-f]{64}\.jpg$/);
    expect(renderObjectKey(sample, now)).toBe(a);
    expect(renderObjectKey({ ...sample, headlineTa: `${sample.headlineTa}.` }, now)).not.toBe(a);
  });
});

describe("jpegDimensions", () => {
  it("rejects non-JPEG bytes", () => {
    expect(jpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});

describe.skipIf(launched === undefined)("renderer (needs Chromium headless shell)", () => {
  const renderer = launched as Renderer;
  afterAll(async () => {
    await renderer.close();
  });

  it.each(SAMPLE_CARDS)("renders $name as a 1080x1350 JPEG with the bundled fonts", async ({ input }) => {
    const result = await renderer.render(input, new Date("2026-10-30T06:00:00Z"));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.width).toBe(1080);
    expect(result.value.height).toBe(1350);
    expect(result.value.jpeg.byteLength).toBeLessThan(2 * 1024 * 1024);
    expect(result.value.jpegSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a headline that cannot fit in four lines instead of overflowing", async () => {
    const tooLong: CardInput = {
      ...sample,
      headlineTa:
        "ஈரோடு மாநகராட்சி பகுதிகளில் குடிநீர் விநியோக நேரம் மாற்றம்: பொதுமக்கள் முன்கூட்டியே தண்ணீர் சேமித்து வைக்க அறிவுறுத்தல்",
    };
    const result = await renderer.render(tooLong, new Date());
    expect(result.ok ? "rendered" : result.error.kind).toBe("text_overflow");
  });

  it("rejects invalid input before rendering", async () => {
    const result = await renderer.render({ ...sample, points: ["1", "2", "3", "4"] }, new Date());
    expect(result.ok).toBe(false);
  });
});
