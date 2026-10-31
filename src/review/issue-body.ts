import type { StoryRelation } from "../domain/ports.ts";
import {
  StoryIdSchema,
  type DraftRevision,
  type IsoDateTime,
  type Story,
  type StoryId,
  type TrustTier,
  type VerificationLevel,
} from "../domain/types.ts";
import { formatIst } from "../publishing/ist.ts";
import { shortHash } from "./revision-hash.ts";

/**
 * A source as the issue shows it: name and link, never the source's own headline or text. The repository is public, so
 * the issue is too (docs/ARCHITECTURE.md §5.9); the editor reads the story at the link.
 */
export type IssueSource = {
  name: string;
  url: string;
  trustTier: TrustTier;
  relation: StoryRelation;
  publishedAt?: IsoDateTime;
};

export type IssueBodyInput = {
  story: Story;
  draft?: DraftRevision;
  verificationLevel: VerificationLevel;
  sources: readonly IssueSource[];
  /** One line per automatic check, for example "Caption 812/1800 characters, 4 hashtags, 0 mentions". */
  checks: readonly string[];
  possibleDuplicates: readonly string[];
  /** Public, unguessable URL of the rendered card. */
  previewUrl?: string;
};

const MARKER_PREFIX = "<!-- erodeglitz:story=";
const MARKER_PATTERN = /^<!-- erodeglitz:story=([0-9a-f-]{36}) -->$/;

export const storyMarker = (id: StoryId): string => `${MARKER_PREFIX}${id} -->`;

/** Reads the marker from the first line only, so text quoted further down cannot impersonate it. */
export const parseStoryMarker = (body: string): StoryId | undefined => {
  const firstLine = body.split("\n", 1)[0]?.trim() ?? "";
  const match = MARKER_PATTERN.exec(firstLine);
  if (match === null) return undefined;
  const parsed = StoryIdSchema.safeParse(match[1]);
  return parsed.success ? parsed.data : undefined;
};

/** Untrusted text (source titles, captions) must not ping people or inject HTML comments or markers. */
export const neutralise = (text: string): string =>
  text
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200B")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Only http(s) URLs, normalised by the WHATWG parser (which percent-encodes `<`, `>` and spaces). */
export const safeUrl = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

/** A code fence longer than any run of backticks inside the text. */
const fenced = (text: string): string => {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  // Inside a fence HTML entities would show literally, so break mentions and comment openers with a zero-width space instead.
  const safe = text.replace(/@(?=[A-Za-z0-9])/g, "@\u200B").replace(/<!--/g, "<!-\u200B-");
  return `${fence}text\n${safe}\n${fence}`;
};

export const REVIEWER_CHECKLIST: readonly string[] = [
  "Facts match the sources; every number, name, date and place has been checked",
  "Verification level meets the minimum for this risk tier",
  "Attribution appears in both caption and graphic",
  "No protected identity (sexual-offence victim, child, juvenile), directly or by combining details",
  "No guilt language before a verdict; the accused's side included where possible",
  "No caste or religion unless essential and approved by the owner",
  "No graphic content; no suicide method or location details; helpline included if relevant",
  "No speculation on a pending court case; no election-restriction breach",
  "Headline is accurate and not sensational",
  "Possible duplicates checked",
  "Tamil is correct and readable; the graphic text matches the caption",
];

/**
 * The editor's headline once there is a draft. Before that, our own label (place and sources), the topic and the end of
 * the story id, so the issues of one run can be told apart; never a source's headline, because the issue is public.
 * (Story ids are UUIDv7: their first characters are the creation time, the same for a run.)
 */
export const renderIssueTitle = (story: Story, draft: DraftRevision | undefined, label?: string): string => {
  const tier = story.riskTier === "R2_SENSITIVE" || story.disputed ? "[R2] " : "";
  const about = label?.replace(/\s+/g, " ").trim();
  const headline = draft?.headlineTa ?? [about, story.topic, story.id.slice(-8)].filter((part) => part !== undefined && part !== "").join(" · ");
  return `${tier}${headline.replace(/@(?=[A-Za-z0-9])/g, "@\u200B")}`.slice(0, 200);
};

export const renderIssueBody = (input: IssueBodyInput): string => {
  const { story, draft } = input;
  const sensitive = story.riskTier === "R2_SENSITIVE" || story.disputed;
  const flags = story.riskFlags.map((f) => f.category);
  const riskLine = [
    `Risk: ${story.riskTier}${story.disputed ? " (disputed)" : ""}${flags.length > 0 ? ` (${[...new Set(flags)].join(", ")})` : ""}`,
    `Verification: ${input.verificationLevel}`,
    draft === undefined ? "No draft yet" : `Revision ${draft.revision}`,
    draft === undefined ? undefined : `rev ${shortHash(draft.revisionHash)}`,
  ]
    .filter((s) => s !== undefined)
    .join(" | ");

  const lines: string[] = [storyMarker(story.id), `## ${neutralise(draft?.headlineTa ?? "(no headline yet)")}`, riskLine, ""];

  lines.push(draft === undefined ? "### Caption" : `### Caption (revision ${draft.revision})`);
  if (draft === undefined) {
    lines.push("No caption yet. Write one with `/caption` followed by the text.");
  } else {
    lines.push(fenced(draft.captionTa), "", `Hashtags: ${draft.hashtags.join(" ")}`, `Alt text: ${neutralise(draft.altText)}`);
  }
  lines.push("");

  lines.push("### Sources");
  if (input.sources.length === 0) lines.push("None recorded.");
  input.sources.forEach((s, i) => {
    const published = s.publishedAt === undefined ? "date unknown" : `published ${formatIst(new Date(s.publishedAt))} ${s.publishedAt.slice(0, 10)}`;
    const url = safeUrl(s.url);
    lines.push(
      `${i + 1}. ${neutralise(s.name)}, ${url === undefined ? "(invalid URL)" : `<${url}>`}, ${published}, tier ${s.trustTier}, ${s.relation}`,
    );
  });
  lines.push("");

  lines.push("### Checks");
  for (const c of input.checks) lines.push(`- ${neutralise(c)}`);
  lines.push(
    `- Possible duplicates: ${input.possibleDuplicates.length === 0 ? "none" : input.possibleDuplicates.map(neutralise).join("; ")}`,
  );
  lines.push("");

  lines.push("### Preview");
  const preview = input.previewUrl === undefined ? undefined : safeUrl(input.previewUrl);
  lines.push(preview === undefined ? "Not rendered yet." : `![preview](<${preview}>)`);
  lines.push("");

  lines.push("### Commands");
  const rev = draft === undefined ? "<rev>" : shortHash(draft.revisionHash);
  const approve = sensitive ? `/approve-sensitive ${rev}` : `/approve ${rev}`;
  lines.push(
    "```text",
    `${approve}   /schedule ${rev} HH:MM   /caption (with text)   /headline <text>`,
    "/attest <how you verified>   /hold <reason>   /unhold   /reject <reason>   /killswitch on <reason>",
    "```",
  );
  if (sensitive) lines.push("Plain `/approve` is refused for this story.");
  lines.push("");

  lines.push(sensitive ? "### Reviewer checklist (required before /approve-sensitive)" : "### Reviewer checklist");
  for (const item of REVIEWER_CHECKLIST) lines.push(`- [ ] ${item}`);

  return lines.join("\n");
};
