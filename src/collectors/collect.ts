import { isCollectable } from "../config/sources.ts";
import { assertNever, err, ok, type Result } from "../lib/result.ts";
import type { Clock, NewSourceItem, SourceFetchState, SourceItemStore, SourceStateStore } from "../domain/ports.ts";
import { IsoDateTimeSchema, MAX_EXCERPT_CHARS, SourceItemSchema, type Source, type SourceItem } from "../domain/types.ts";
import {
  canonicalUrl,
  guessLanguage,
  normaliseForComparison,
  normaliseForStorage,
  sha256Hex,
  truncateGraphemes,
} from "../pipeline/normalise.ts";
import { extractListingLinks, extractPublishedTime, parseFeed, parseSitemap, type FeedError } from "./feeds.ts";
import { httpGet, type FetchLike, type HttpGetError } from "./http.ts";
import { isAllowed, parseRobots } from "./robots.ts";

/** After this many consecutive failures the source should be disabled and an alert raised. */
export const DISABLE_AFTER_FAILURES = 6;

export const DEFAULT_MAX_ITEMS_PER_RUN = 50;

/**
 * Listing pages give no dates, so each new article is opened once to read its publication time (Coimbatore 360 does the
 * same). Articles without a readable date are skipped, so old stories on a listing page never pass as today's news.
 */
export const MAX_ARTICLE_FETCHES_PER_RUN = 15;
const ARTICLE_PAUSE_MS = 1500;
/** A publication time further ahead than this is a broken page, not a date. */
const MAX_FUTURE_SKEW_MS = 60 * 60_000;

/** Per-run cache of robots decisions by origin, so sources on one site fetch robots.txt once. */
export type RobotsEntry = { kind: "rules"; text: string } | { kind: "allow_all" } | { kind: "unreachable"; message: string };
export type RobotsCache = Map<string, RobotsEntry>;

export type CollectDeps = {
  clock: Clock;
  sourceState: SourceStateStore;
  sourceItems: SourceItemStore;
  contactUrl: string;
  fetch?: FetchLike;
  robotsCache?: RobotsCache;
  maxItemsPerRun?: number;
  /** Wait between article requests. Defaults to a real timer. */
  pause?: (ms: number) => Promise<void>;
};

export type CollectOutcome =
  | { status: "skipped"; sourceId: string; reason: string }
  | { status: "not_modified"; sourceId: string }
  | {
      status: "fetched";
      sourceId: string;
      /** Candidates found in the document. */
      seen: number;
      /** Candidates dropped as unusable (bad URL, empty title, off-site). */
      invalid: number;
      /** New listing-page articles skipped because no publication time could be read (tried again next run). */
      undated: number;
      inserted: readonly SourceItem[];
    }
  | { status: "failed"; sourceId: string; error: string; consecutiveFailures: number; shouldDisable: boolean };

type Candidate = { link: string; title: string; publishedAt?: Date; summary?: string };

const describeHttpError = (e: HttpGetError): string => {
  switch (e.kind) {
    case "timeout":
    case "network":
    case "too_large":
    case "http_status":
      return `${e.kind}: ${e.message}`;
    case "rate_limited":
      return `rate_limited: ${e.message}${e.retryAfterSeconds === undefined ? "" : ` (retry after ${e.retryAfterSeconds} s)`}`;
    default:
      return assertNever(e);
  }
};

const robotsDecision = async (url: URL, deps: CollectDeps): Promise<Result<true, string>> => {
  const cache: RobotsCache = deps.robotsCache ?? new Map<string, RobotsEntry>();
  let entry = cache.get(url.origin);
  if (entry === undefined) {
    const res = await httpGet(
      { url: `${url.origin}/robots.txt`, accept: "text/plain", maxBytes: 512 * 1024 },
      { contactUrl: deps.contactUrl, now: deps.clock.now, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) },
    );
    if (res.ok) {
      entry = res.value.kind === "ok" ? { kind: "rules", text: res.value.body } : { kind: "allow_all" };
    } else if (res.error.kind === "http_status" && res.error.status >= 400 && res.error.status < 500) {
      // RFC 9309: robots.txt unavailable (4xx) means no restrictions.
      entry = { kind: "allow_all" };
    } else {
      // RFC 9309: unreachable (5xx, network) means assume complete disallow.
      entry = { kind: "unreachable", message: describeHttpError(res.error) };
    }
    cache.set(url.origin, entry);
  }
  switch (entry.kind) {
    case "allow_all":
      return ok(true);
    case "unreachable":
      return err(`robots.txt unreachable, treated as disallow (${entry.message})`);
    case "rules":
      return isAllowed(parseRobots(entry.text), `${url.pathname}${url.search}`)
        ? ok(true)
        : err(`robots.txt disallows ${url.pathname}`);
    default:
      return assertNever(entry);
  }
};

const candidatesFrom = (source: Source, body: string, finalUrl: string): Result<readonly Candidate[], FeedError> => {
  switch (source.kind) {
    case "rss":
    case "atom": {
      const r = parseFeed(body);
      return r.ok ? ok(r.value.map((e) => ({ ...e }))) : r;
    }
    case "sitemap": {
      const r = parseSitemap(body);
      if (!r.ok) return r;
      const out: Candidate[] = [];
      for (const e of r.value) {
        // Plain sitemaps carry no titles; only news sitemaps give usable candidates without fetching each page.
        if (e.title === undefined) continue;
        out.push({ link: e.loc, title: e.title, ...(e.lastmod === undefined ? {} : { publishedAt: e.lastmod }) });
      }
      return ok(out);
    }
    case "listing_page": {
      if (source.linkPattern === undefined) return err({ kind: "invalid_pattern", message: "no linkPattern" });
      const r = extractListingLinks(body, finalUrl, source.linkPattern);
      return r.ok ? ok(r.value.map((l) => ({ link: l.url, title: l.title }))) : r;
    }
    case "editor_tip":
      return ok([]);
    default:
      return assertNever(source.kind);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens one article (robots.txt permitting) and reads only its publication time; the body is not kept. */
const articlePublishedAt = async (url: string, now: Date, deps: CollectDeps): Promise<Date | undefined> => {
  const robots = await robotsDecision(new URL(url), deps);
  if (!robots.ok) return undefined;
  const res = await httpGet(
    { url, accept: "text/html" },
    { contactUrl: deps.contactUrl, now: deps.clock.now, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) },
  );
  if (!res.ok || res.value.kind !== "ok") return undefined;
  const publishedAt = extractPublishedTime(res.value.body);
  return publishedAt !== undefined && publishedAt.getTime() <= now.getTime() + MAX_FUTURE_SKEW_MS ? publishedAt : undefined;
};

const NewSourceItemSchema = SourceItemSchema.omit({ id: true });

/** Builds a validated item: metadata and a short excerpt only, never the article body. */
export const toNewSourceItem = (source: Source, candidate: Candidate, baseUrl: string, fetchedAt: Date): NewSourceItem | undefined => {
  const canonical = canonicalUrl(candidate.link, baseUrl);
  if (!canonical.ok) return undefined;
  const title = truncateGraphemes(normaliseForStorage(candidate.title), 500);
  if (title === "") return undefined;
  const excerpt = candidate.summary === undefined ? undefined : truncateGraphemes(normaliseForStorage(candidate.summary), MAX_EXCERPT_CHARS);
  const parsed = NewSourceItemSchema.safeParse({
    sourceId: source.id,
    canonicalUrl: canonical.value,
    urlHash: sha256Hex(canonical.value),
    title,
    ...(excerpt === undefined || excerpt === "" ? {} : { excerpt }),
    language: guessLanguage(`${title} ${excerpt ?? ""}`),
    ...(candidate.publishedAt === undefined ? {} : { publishedAt: candidate.publishedAt.toISOString() }),
    fetchedAt: fetchedAt.toISOString(),
    contentHash: sha256Hex(normaliseForComparison(`${title}\n${excerpt ?? ""}`)),
  });
  return parsed.success ? parsed.data : undefined;
};

/**
 * One collection pass for one source: terms gate, due check, robots.txt, conditional GET, parse, store new items,
 * save fetch state. Errors are returned, never thrown, so one bad source cannot stop the others.
 */
export const collectSource = async (source: Source, deps: CollectDeps): Promise<CollectOutcome> => {
  const now = deps.clock.now();
  const gate = isCollectable(source, now);
  if (!gate.ok) return { status: "skipped", sourceId: source.id, reason: gate.error.message };

  const state = await deps.sourceState.getFetchState(source.id);
  if (state.lastFetchedAt !== undefined) {
    const dueAt = Date.parse(state.lastFetchedAt) + source.fetchIntervalMinutes * 60_000;
    if (now.getTime() < dueAt) return { status: "skipped", sourceId: source.id, reason: "not due yet" };
  }

  const fail = async (error: string): Promise<CollectOutcome> => {
    const consecutiveFailures = state.consecutiveFailures + 1;
    await deps.sourceState.saveFetchState({ ...state, consecutiveFailures });
    return {
      status: "failed",
      sourceId: source.id,
      error,
      consecutiveFailures,
      shouldDisable: consecutiveFailures >= DISABLE_AFTER_FAILURES,
    };
  };

  const robots = await robotsDecision(new URL(source.url), deps);
  if (!robots.ok) {
    return robots.error.startsWith("robots.txt disallows")
      ? { status: "skipped", sourceId: source.id, reason: robots.error }
      : fail(robots.error);
  }

  const res = await httpGet(
    {
      url: source.url,
      ...(state.etag === undefined ? {} : { etag: state.etag }),
      ...(state.lastModified === undefined ? {} : { lastModified: state.lastModified }),
    },
    { contactUrl: deps.contactUrl, now: deps.clock.now, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) },
  );
  if (!res.ok) return fail(describeHttpError(res.error));

  const fetchedAtIso = IsoDateTimeSchema.parse(now.toISOString());
  if (res.value.kind === "not_modified") {
    await deps.sourceState.saveFetchState({ ...state, lastFetchedAt: fetchedAtIso, consecutiveFailures: 0 });
    return { status: "not_modified", sourceId: source.id };
  }

  const page = res.value;
  const candidates = candidatesFrom(source, page.body, page.finalUrl);
  if (!candidates.ok) return fail(`${candidates.error.kind}: ${candidates.error.message}`);

  const limit = deps.maxItemsPerRun ?? DEFAULT_MAX_ITEMS_PER_RUN;
  const inserted: SourceItem[] = [];
  let invalid = 0;
  let undated = 0;
  let articleFetches = 0;
  for (const candidate of candidates.value.slice(0, limit)) {
    let item = toNewSourceItem(source, candidate, page.finalUrl, now);
    if (item === undefined) {
      invalid += 1;
      continue;
    }
    if (item.publishedAt === undefined && source.kind === "listing_page") {
      if (await deps.sourceItems.isKnown(item.sourceId, item.urlHash)) continue;
      if (articleFetches >= MAX_ARTICLE_FETCHES_PER_RUN) {
        undated += 1;
        continue;
      }
      if (articleFetches > 0) await (deps.pause ?? sleep)(ARTICLE_PAUSE_MS);
      articleFetches += 1;
      const publishedAt = await articlePublishedAt(item.canonicalUrl, now, deps);
      if (publishedAt === undefined) {
        undated += 1;
        continue;
      }
      item = { ...item, publishedAt: IsoDateTimeSchema.parse(publishedAt.toISOString()) };
    }
    const r = await deps.sourceItems.insertIfNew(item);
    if (r.inserted) inserted.push(r.item);
  }

  const next: SourceFetchState = {
    sourceId: source.id,
    consecutiveFailures: 0,
    lastFetchedAt: fetchedAtIso,
    ...(page.etag === undefined ? {} : { etag: page.etag }),
    ...(page.lastModified === undefined ? {} : { lastModified: page.lastModified }),
  };
  await deps.sourceState.saveFetchState(next);
  return { status: "fetched", sourceId: source.id, seen: candidates.value.length, invalid, undated, inserted };
};
