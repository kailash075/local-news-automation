import { XMLParser } from "fast-xml-parser";
import { err, ok, type Result } from "../lib/result.ts";
import { MAX_EXCERPT_CHARS } from "../domain/types.ts";
import { canonicalUrl, normaliseForStorage, stripHtml, truncateGraphemes } from "../pipeline/normalise.ts";

/**
 * Parsing of what collectors fetch: RSS 2.0 / RSS 1.0 / Atom feeds, XML sitemaps (including Google News sitemaps) and
 * listing pages. Output is candidate metadata only: title, link, time and a short plain-text summary.
 */

export type FeedEntry = {
  title: string;
  link: string;
  publishedAt?: Date;
  summary?: string;
};

export type FeedError = { kind: "invalid_xml" | "unknown_format" | "invalid_pattern"; message: string };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

type Node = Readonly<Record<string, unknown>>;

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

const asArray = (v: unknown): readonly unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

const child = (node: unknown, key: string): unknown => (isNode(node) ? node[key] : undefined);

/** Text content of a parsed node: a string, a number, a `#text` holder, or the first of several. */
const textOf = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = textOf(x);
      if (t !== undefined && t !== "") return t;
    }
    return undefined;
  }
  if (isNode(v)) return textOf(v["#text"]);
  return undefined;
};

const parseDate = (v: string | undefined): Date | undefined => {
  if (v === undefined || v.trim() === "") return undefined;
  const ms = Date.parse(v.trim());
  return Number.isNaN(ms) ? undefined : new Date(ms);
};

const plainSummary = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const text = stripHtml(v);
  return text === "" ? undefined : truncateGraphemes(text, MAX_EXCERPT_CHARS);
};

const parseXml = (xml: string): Result<unknown, FeedError> => {
  try {
    const parsed: unknown = parser.parse(xml);
    return ok(parsed);
  } catch (e: unknown) {
    return err({ kind: "invalid_xml", message: e instanceof Error ? e.message.slice(0, 200) : "invalid XML" });
  }
};

const entry = (title: string | undefined, link: string | undefined, published: string | undefined, summary: string | undefined): FeedEntry | undefined => {
  const t = title === undefined ? "" : stripHtml(title);
  const l = link?.trim() ?? "";
  if (t === "" || l === "") return undefined;
  const publishedAt = parseDate(published);
  const s = plainSummary(summary);
  return {
    title: t,
    link: l,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(s === undefined ? {} : { summary: s }),
  };
};

/** The entry's alternate (web page) link; links with another rel, such as "enclosure" or "self", are skipped. */
const atomLink = (v: unknown): string | undefined => {
  for (const l of asArray(v)) {
    if (typeof l === "string") return l;
    const href = textOf(child(l, "@_href"));
    const rel = textOf(child(l, "@_rel"));
    if (href !== undefined && (rel === undefined || rel === "alternate")) return href;
  }
  return undefined;
};

/** RSS 2.0, RSS 1.0 (RDF) or Atom, detected from the root element. */
export const parseFeed = (xml: string): Result<readonly FeedEntry[], FeedError> => {
  const parsed = parseXml(xml);
  if (!parsed.ok) return parsed;
  const root = parsed.value;
  const out: FeedEntry[] = [];

  const rss = child(root, "rss");
  const rdf = child(root, "RDF");
  const atom = child(root, "feed");

  if (rss !== undefined || rdf !== undefined) {
    const items = rss !== undefined ? asArray(child(child(rss, "channel"), "item")) : asArray(child(rdf, "item"));
    for (const item of items) {
      const e = entry(
        textOf(child(item, "title")),
        textOf(child(item, "link")) ?? textOf(child(item, "guid")),
        textOf(child(item, "pubDate")) ?? textOf(child(item, "date")),
        textOf(child(item, "description")) ?? textOf(child(item, "encoded")),
      );
      if (e !== undefined) out.push(e);
    }
    return ok(out);
  }
  if (atom !== undefined) {
    for (const item of asArray(child(atom, "entry"))) {
      const e = entry(
        textOf(child(item, "title")),
        atomLink(child(item, "link")),
        textOf(child(item, "published")) ?? textOf(child(item, "updated")),
        textOf(child(item, "summary")) ?? textOf(child(item, "content")),
      );
      if (e !== undefined) out.push(e);
    }
    return ok(out);
  }
  return err({ kind: "unknown_format", message: "not an RSS, RDF or Atom document" });
};

export type SitemapEntry = { loc: string; lastmod?: Date; title?: string };

/** `<urlset>` entries. Google News sitemaps also give a title (`news:news/news:title`) and publication date. */
export const parseSitemap = (xml: string): Result<readonly SitemapEntry[], FeedError> => {
  const parsed = parseXml(xml);
  if (!parsed.ok) return parsed;
  const urlset = child(parsed.value, "urlset");
  if (urlset === undefined) return err({ kind: "unknown_format", message: "not a <urlset> sitemap" });
  const out: SitemapEntry[] = [];
  for (const u of asArray(child(urlset, "url"))) {
    const loc = textOf(child(u, "loc"))?.trim();
    if (loc === undefined || loc === "") continue;
    const news = child(u, "news");
    const lastmod = parseDate(textOf(child(news, "publication_date")) ?? textOf(child(u, "lastmod")));
    const rawTitle = textOf(child(news, "title"));
    const title = rawTitle === undefined ? undefined : stripHtml(rawTitle);
    out.push({
      loc,
      ...(lastmod === undefined ? {} : { lastmod }),
      ...(title === undefined || title === "" ? {} : { title }),
    });
  }
  return ok(out);
};

export type ListingLink = { url: string; title: string };

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m === null ? undefined : (m[1] ?? m[2] ?? m[3]);
};

const sameSite = (a: URL, b: URL): boolean => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

/**
 * Article links on a listing page. `linkPattern` is matched against each anchor's href; capture group 1 (or the whole
 * match) is the link. The title is the anchor text (or its title attribute). Only links on the page's own site are kept;
 * duplicates keep the longest title. At most `limit` links.
 */
export const extractListingLinks = (
  html: string,
  pageUrl: string,
  linkPattern: string,
  limit = 60,
): Result<readonly ListingLink[], FeedError> => {
  let pattern: RegExp;
  try {
    pattern = new RegExp(linkPattern);
  } catch (e: unknown) {
    return err({ kind: "invalid_pattern", message: e instanceof Error ? e.message : "invalid pattern" });
  }
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return err({ kind: "invalid_pattern", message: `invalid page URL ${pageUrl}` });
  }

  const found = new Map<string, string>();
  for (const m of html.matchAll(ANCHOR)) {
    const attrs = m[1] ?? "";
    const href = attr(attrs, "href");
    if (href === undefined) continue;
    const hit = pattern.exec(href.trim());
    if (hit === null) continue;
    const raw = hit[1] ?? hit[0];
    const canonical = canonicalUrl(raw, page.toString());
    if (!canonical.ok) continue;
    if (!sameSite(new URL(canonical.value), page)) continue;
    const text = stripHtml(m[2] ?? "");
    const title = normaliseForStorage(text !== "" ? text : stripHtml(attr(attrs, "title") ?? ""));
    if (title === "") continue;
    const previous = found.get(canonical.value);
    if (previous === undefined || title.length > previous.length) found.set(canonical.value, title);
    if (found.size >= limit && previous === undefined) break;
  }
  return ok([...found].map(([url, title]) => ({ url, title })));
};
