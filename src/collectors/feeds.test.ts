import { describe, expect, it } from "vitest";
import { MAX_EXCERPT_CHARS } from "../domain/types.ts";
import { extractListingLinks, parseFeed, parseSitemap } from "./feeds.ts";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example</title>
    <item>
      <title><![CDATA[ஈரோட்டில் நாளை மின்தடை]]></title>
      <link>https://example.com/news/1?utm_source=rss</link>
      <pubDate>Thu, 30 Oct 2026 05:00:00 +0530</pubDate>
      <description><![CDATA[<p>பெருந்துறை &amp; சென்னிமலை <b>பகுதிகளில்</b></p><img src="x.jpg"/>]]></description>
    </item>
    <item>
      <title>No link here</title>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/news/2</link>
      <dc:date>2026-10-30T06:00:00+05:30</dc:date>
      <description>${"அ".repeat(800)}</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <entry>
    <title type="html">Erode: rain alert</title>
    <link rel="enclosure" href="https://example.com/a.mp3"/>
    <link rel="alternate" href="https://example.com/atom/1"/>
    <updated>2026-10-30T01:00:00Z</updated>
    <summary>Heavy rain likely</summary>
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("parses RSS 2.0 items, strips HTML and skips items without a link", () => {
    const r = parseFeed(RSS);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toHaveLength(2);
    expect(r.value[0]).toEqual({
      title: "ஈரோட்டில் நாளை மின்தடை",
      link: "https://example.com/news/1?utm_source=rss",
      publishedAt: new Date("2026-10-29T23:30:00Z"),
      summary: "பெருந்துறை & சென்னிமலை பகுதிகளில்",
    });
    expect(r.value[1]?.publishedAt).toEqual(new Date("2026-10-30T00:30:00Z"));
    expect(r.value[1]?.summary?.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
  });

  it("parses Atom entries using the alternate link", () => {
    const r = parseFeed(ATOM);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toEqual([
      { title: "Erode: rain alert", link: "https://example.com/atom/1", publishedAt: new Date("2026-10-30T01:00:00Z"), summary: "Heavy rain likely" },
    ]);
  });

  it("rejects documents that are not feeds", () => {
    expect(parseFeed("<html><body>hi</body></html>")).toMatchObject({ ok: false, error: { kind: "unknown_format" } });
  });
});

describe("parseSitemap", () => {
  it("reads locations, dates and news titles", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url><loc>https://example.com/a</loc><lastmod>2026-10-30T05:00:00Z</lastmod></url>
  <url><loc>https://example.com/b</loc>
    <news:news><news:publication_date>2026-10-30T06:00:00+05:30</news:publication_date><news:title>ஈரோடு செய்தி</news:title></news:news>
  </url>
</urlset>`;
    const r = parseSitemap(xml);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toEqual([
      { loc: "https://example.com/a", lastmod: new Date("2026-10-30T05:00:00Z") },
      { loc: "https://example.com/b", lastmod: new Date("2026-10-30T00:30:00Z"), title: "ஈரோடு செய்தி" },
    ]);
  });
});

describe("extractListingLinks", () => {
  const html = `
    <a href="/news/erode/123"><img src="a.jpg"></a>
    <a href="/news/erode/123" class="title">ஈரோட்டில் <b>மின்தடை</b></a>
    <a href='https://www.example.com/news/erode/124?utm_medium=x'>Second story</a>
    <a href="https://other.example.org/news/erode/999">Off-site</a>
    <a href="/about">About us</a>
    <a href="/news/erode/125" title="Title attribute only"></a>`;

  it("keeps matching same-site links with their anchor text, deduplicated", () => {
    const r = extractListingLinks(html, "https://example.com/list", "^(?:https://(?:www\\.)?example\\.com)?(/news/erode/\\d+)");
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toEqual([
      { url: "https://example.com/news/erode/123", title: "ஈரோட்டில் மின்தடை" },
      { url: "https://example.com/news/erode/124", title: "Second story" },
      { url: "https://example.com/news/erode/125", title: "Title attribute only" },
    ]);
  });

  it("reports an invalid pattern", () => {
    expect(extractListingLinks(html, "https://example.com/", "(")).toMatchObject({ ok: false, error: { kind: "invalid_pattern" } });
  });
});
