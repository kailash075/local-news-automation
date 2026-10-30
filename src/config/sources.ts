import { z } from "zod";
import { err, ok, type Result } from "../lib/result.ts";
import { SourceSchema, type Source } from "../domain/types.ts";

/**
 * Source registry (docs/EDITORIAL_POLICY.md §3). Version-controlled; mirrored into the `sources` table.
 *
 * Every external source starts with terms review "pending" and `enabled: false`: the collector refuses to fetch it
 * until the owner has reviewed its terms of use and robots.txt, recorded the review here, and verified the URL.
 * URLs below are the publishers' known pages; none of their feed or page formats has been verified yet.
 */

const PENDING = {
  status: "pending",
  notes: "",
  allowedUse: "facts_with_attribution",
  llmInputAllowed: false,
} as const;

const RAW_SOURCES: readonly z.input<typeof SourceSchema>[] = [
  {
    id: "erode-district-administration",
    name: "Erode District Administration",
    kind: "listing_page",
    url: "https://erode.nic.in/",
    trustTier: "T1_official",
    erodeSpecific: true,
    termsReview: {
      ...PENDING,
      notes: "Unverified: press-release page path, its HTML structure and the site's terms. Set linkPattern after review.",
    },
    fetchIntervalMinutes: 120,
    enabled: false,
  },
  {
    id: "erode-city-corporation",
    name: "Erode City Municipal Corporation",
    kind: "listing_page",
    url: "https://www.tnurbantree.tn.gov.in/erode/",
    trustTier: "T1_official",
    erodeSpecific: true,
    termsReview: {
      ...PENDING,
      notes: "Unverified: this URL, the notices page and the site's terms. Set linkPattern after review.",
    },
    fetchIntervalMinutes: 240,
    enabled: false,
  },
  {
    id: "tn-dipr",
    name: "Tamil Nadu DIPR press releases",
    kind: "listing_page",
    url: "https://www.dipr.tn.gov.in/",
    trustTier: "T1_official",
    erodeSpecific: false,
    termsReview: {
      ...PENDING,
      notes: "Unverified: whether a feed exists, the press-release page and the site's terms. Statewide: gazetteer match required.",
    },
    fetchIntervalMinutes: 120,
    enabled: false,
  },
  {
    id: "tnpdcl-erode-outages",
    name: "TNPDCL planned outages (Erode circle)",
    kind: "listing_page",
    url: "https://www.tnebltd.gov.in/",
    trustTier: "T1_official",
    erodeSpecific: false,
    termsReview: {
      ...PENDING,
      notes: "Unverified: the planned-outage page for Erode circle, its format and the site's terms. Highest-priority topic.",
    },
    fetchIntervalMinutes: 120,
    enabled: false,
  },
  {
    id: "imd-rmc-chennai",
    name: "India Meteorological Department, Regional Meteorological Centre Chennai",
    kind: "listing_page",
    url: "https://mausam.imd.gov.in/chennai/",
    trustTier: "T1_official",
    erodeSpecific: false,
    termsReview: {
      ...PENDING,
      notes: "Unverified: district warning page or feed for Erode, its format and the site's terms.",
    },
    fetchIntervalMinutes: 180,
    enabled: false,
  },
  {
    id: "pib",
    name: "Press Information Bureau",
    kind: "rss",
    url: "https://pib.gov.in/",
    trustTier: "T1_official",
    erodeSpecific: false,
    termsReview: {
      ...PENDING,
      notes: "Unverified: replace url with the verified RSS feed URL before approval. National: gazetteer match required.",
    },
    fetchIntervalMinutes: 240,
    enabled: false,
  },
  {
    id: "dinamalar-erode",
    name: "Dinamalar, Erode district news",
    kind: "listing_page",
    url: "https://www.dinamalar.com/news/tamil-nadu-district-news-erode",
    trustTier: "T2_established_publisher",
    erodeSpecific: true,
    termsReview: {
      status: "pending",
      allowedUse: "discovery_only",
      llmInputAllowed: false,
      notes:
        "Owner-nominated, discovery only. Checked 2026-10-30: page returns HTTP 200; robots.txt does not disallow /news/ for " +
        "general crawlers but blocks GPTBot and names other AI crawlers (ChatGPT-User, Google-Extended, CCBot), so its text " +
        "must never reach an AI model. Terms of use not reviewed. Article link pattern not set. Sitemaps (e.g. sitemap_cities.xml) " +
        "may be a lighter alternative to the listing page.",
    },
    fetchIntervalMinutes: 120,
    enabled: false,
  },
  {
    id: "editor-tip",
    name: "Editor tips (GitHub issue form)",
    kind: "editor_tip",
    url: "https://github.com/kailash075/local-news-automation/issues",
    trustTier: "T3_other",
    erodeSpecific: false,
    termsReview: {
      status: "approved",
      allowedUse: "facts_with_attribution",
      llmInputAllowed: false,
      notes: "Own intake, never fetched. Tips are leads only and need V2 or V3 verification before publication.",
    },
    fetchIntervalMinutes: 60,
    enabled: true,
  },
];

export const SOURCES: readonly Source[] = z.array(SourceSchema).parse(RAW_SOURCES);

export const sourceById = (id: string): Source | undefined => SOURCES.find((s) => s.id === id);

/** Terms reviews older than this must be redone before the collector fetches again. */
export const TERMS_REVIEW_MAX_AGE_DAYS = 180;

export type CollectBlock =
  | { code: "disabled"; message: string }
  | { code: "not_fetchable"; message: string }
  | { code: "terms_not_approved"; message: string }
  | { code: "terms_review_undated"; message: string }
  | { code: "terms_review_expired"; message: string }
  | { code: "missing_link_pattern"; message: string };

/** The collector may fetch this source now. Fails closed on anything missing. */
export const isCollectable = (source: Source, now: Date): Result<Source, CollectBlock> => {
  if (source.kind === "editor_tip") {
    return err({ code: "not_fetchable", message: `${source.id}: editor tips arrive as issues and are never fetched` });
  }
  if (!source.enabled) return err({ code: "disabled", message: `${source.id}: disabled` });
  if (source.termsReview.status !== "approved") {
    return err({ code: "terms_not_approved", message: `${source.id}: terms review is ${source.termsReview.status}` });
  }
  if (source.termsReview.reviewedAt === undefined) {
    return err({ code: "terms_review_undated", message: `${source.id}: terms review has no date` });
  }
  const ageDays = (now.getTime() - Date.parse(source.termsReview.reviewedAt)) / 86_400_000;
  if (!(ageDays <= TERMS_REVIEW_MAX_AGE_DAYS)) {
    return err({
      code: "terms_review_expired",
      message: `${source.id}: terms review is ${Math.floor(ageDays)} days old (limit ${TERMS_REVIEW_MAX_AGE_DAYS})`,
    });
  }
  if (source.kind === "listing_page" && source.linkPattern === undefined) {
    return err({ code: "missing_link_pattern", message: `${source.id}: listing page without linkPattern` });
  }
  return ok(source);
};
