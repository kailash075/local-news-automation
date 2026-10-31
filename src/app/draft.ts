import { assembleCaptionBody, composeCaption, hashtagsFor } from "../captions/caption.ts";
import { validateCaption } from "../captions/validate.ts";
import { ALERT_TOPICS, CREDIT_TA, TOPIC_LABEL_TA, placeDisplayTa } from "../config/labels.ts";
import { uuidv7 } from "../lib/ids.ts";
import type { Clock, ObjectStore, Stores } from "../domain/ports.ts";
import { transition } from "../domain/story-state.ts";
import {
  DraftIdSchema,
  type DraftRevision,
  type EditorialDecision,
  type Source,
  type SourceItem,
  type Story,
  type StoryStatus,
} from "../domain/types.ts";
import { deriveVerificationLevel } from "../domain/verification.ts";
import { formatTamilDate } from "../graphics/tamil-date.ts";
import type { RenderError, Renderer } from "../graphics/render.ts";
import { TEMPLATE_VERSION, type CardInput } from "../graphics/templates.ts";
import type { IssuesClient } from "../github/issues.ts";
import { toIso } from "../publishing/ist.ts";
import { renderIssueBody, renderIssueTitle, storyMarker, type IssueSource } from "../review/issue-body.ts";
import { revisionHash } from "../review/revision-hash.ts";

export type DraftDeps = {
  stores: Pick<Stores, "stories" | "drafts" | "decisions" | "evidence" | "sourceItems" | "reviewThreads">;
  clock: Clock;
  sourceFor: (id: string) => Source | undefined;
  objects: Pick<ObjectStore, "put" | "publicUrl">;
  issues: Pick<IssuesClient, "create" | "update" | "comment" | "findByMarker">;
  /** Started lazily: Chromium is launched only when a card has to be rendered. */
  renderer: () => Promise<Renderer>;
};

export const ACTIVE_STATUSES: readonly StoryStatus[] = ["awaiting_caption", "in_review", "approved"];
const STORY_LABEL = "story";

type CaptionRequest = { headlineTa: string; factLines: readonly string[]; requestedAt: string };

const latest = (decisions: readonly EditorialDecision[], kind: EditorialDecision["kind"]): EditorialDecision | undefined =>
  decisions.filter((d) => d.kind === kind && d.reason !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);

/**
 * Editor input for the next revision. `/caption`: the first line is the headline, the following lines are the facts.
 * A later `/headline` replaces only the headline.
 */
export const captionRequest = (decisions: readonly EditorialDecision[]): CaptionRequest | undefined => {
  const caption = latest(decisions, "caption");
  if (caption?.reason === undefined) return undefined;
  const lines = caption.reason
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const [first, ...facts] = lines;
  if (first === undefined) return undefined;
  const headline = latest(decisions, "headline");
  const headlineIsNewer = headline?.reason !== undefined && headline.createdAt > caption.createdAt;
  return {
    headlineTa: headlineIsNewer ? headline.reason ?? first : first,
    factLines: facts,
    requestedAt: headlineIsNewer ? headline.createdAt : caption.createdAt,
  };
};

const sourceCredit = (items: readonly SourceItem[], sourceFor: DraftDeps["sourceFor"]): string => {
  const rank = { T1_official: 0, T2_established_publisher: 1, T3_other: 2 } as const;
  const sources = [...new Map(items.map((i) => [i.sourceId, sourceFor(i.sourceId)])).values()]
    .filter((s): s is Source => s !== undefined && s.kind !== "editor_tip")
    .sort((a, b) => rank[a.trustTier] - rank[b.trustTier]);
  const names: string[] = [];
  for (const s of sources) {
    const candidate = [...names, CREDIT_TA[s.id] ?? s.name];
    if (`தகவல்: ${candidate.join(", ")}`.length > 80) break;
    names.push(CREDIT_TA[s.id] ?? s.name);
  }
  return names.length === 0 ? "தகவல்: ErodeGlitz" : `தகவல்: ${names.join(", ")}`;
};

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

const describeRenderError = (e: RenderError): string => {
  switch (e.kind) {
    case "text_overflow":
      return e.field === "headline" ? "The headline is too long for the card. Shorten it with /headline." : "The fact lines do not fit on the card. Shorten the /caption lines.";
    case "invalid_input":
      return `The card input is invalid: ${e.message}`;
    case "font_not_loaded":
      return "The Tamil font did not load; this is a system problem, not your text.";
    case "bad_output":
      return `The rendered image failed its checks: ${e.message}`;
  }
};

/**
 * Work for the Chromium job: stories that need a new revision or still have no review issue. With `refreshIssues`,
 * every active story counts, because its issue is rewritten. A fixed number of Sheet reads, however many stories are open.
 */
export const pendingDraftWork = async (deps: Pick<DraftDeps, "stores">, onlyStoryId?: string, refreshIssues = false): Promise<number> => {
  const [unassigned, active] = await Promise.all([
    deps.stores.sourceItems.listUnassigned(1),
    deps.stores.stories.listByStatus(ACTIVE_STATUSES, 100),
  ]);
  const stories = active.filter((s) => onlyStoryId === undefined || s.id === onlyStoryId);
  if (onlyStoryId !== undefined || refreshIssues) return unassigned.length + stories.length;
  const ids = stories.map((s) => s.id);
  const [decisions, drafts, issues] = await Promise.all([
    deps.stores.decisions.listForStories(ids),
    deps.stores.drafts.latestForStories(ids),
    deps.stores.reviewThreads.issueNumbersFor(ids),
  ]);
  const waiting = stories.filter((story) => {
    const request = captionRequest(decisions.get(story.id) ?? []);
    const draft = drafts.get(story.id);
    const needsRevision = request !== undefined && (draft === undefined || request.requestedAt > draft.createdAt);
    return needsRevision || !issues.has(story.id);
  });
  return unassigned.length + waiting.length;
};

const buildRevision = async (
  deps: DraftDeps,
  story: Story,
  request: CaptionRequest,
  items: readonly SourceItem[],
  previous: DraftRevision | undefined,
): Promise<{ ok: true; draft: DraftRevision } | { ok: false; message: string }> => {
  const now = deps.clock.now();
  const placeTa = placeDisplayTa(story.placeTags[0]);
  const sourceCreditTa = sourceCredit(items, deps.sourceFor);
  const hashtags = hashtagsFor(story.topic);
  const dateTa = formatTamilDate(now);
  const captionTa = assembleCaptionBody({ headlineTa: request.headlineTa, factLines: request.factLines, placeTa, dateTa });
  const altText = clip(`${request.headlineTa}. ${request.factLines.join(" ")} ${sourceCreditTa}. ErodeGlitz செய்தி அட்டை.`, 1000);
  const card: CardInput = {
    template: ALERT_TOPICS.has(story.topic) ? "alert" : "news",
    categoryTa: TOPIC_LABEL_TA[story.topic],
    placeTa,
    headlineTa: clip(request.headlineTa, 120),
    points: request.factLines.slice(0, 3).map((l) => clip(l, 90)),
    dateTa,
    sourceCreditTa,
  };

  const renderer = await deps.renderer();
  const rendered = await renderer.render(card, now);
  if (!rendered.ok) return { ok: false, message: describeRenderError(rendered.error) };
  await deps.objects.put(rendered.value.objectKey, rendered.value.jpeg, "image/jpeg");

  const revision = (previous?.revision ?? 0) + 1;
  const sources = items.map((i) => ({ name: deps.sourceFor(i.sourceId)?.name ?? i.sourceId, url: i.canonicalUrl }));
  const draft: DraftRevision = {
    id: DraftIdSchema.parse(uuidv7(now)),
    storyId: story.id,
    revision,
    revisionHash: revisionHash({
      storyId: story.id,
      revision,
      headlineTa: request.headlineTa,
      captionTa,
      hashtags,
      altText,
      sourceCreditTa,
      templateVersion: TEMPLATE_VERSION,
      renderSha256: rendered.value.jpegSha256,
      sources,
    }),
    headlineTa: request.headlineTa,
    captionTa,
    hashtags,
    altText,
    sourceCreditTa,
    templateVersion: TEMPLATE_VERSION,
    renderKey: rendered.value.objectKey,
    renderSha256: rendered.value.jpegSha256,
    origin: "manual",
    createdAt: toIso(now),
  };
  await deps.stores.drafts.insert(draft);
  return { ok: true, draft };
};

/** New review issues per run, so a busy day (or the first run) does not flood the editor. The rest wait for the next run. */
export const MAX_NEW_ISSUES_PER_RUN = 10;

export type DraftReport = {
  revisions: number;
  issuesCreated: number;
  issuesUpdated: number;
  /** Stories still without a review issue because this run reached MAX_NEW_ISSUES_PER_RUN. */
  deferred: number;
  problems: readonly string[];
};

/** `refreshIssues` rewrites the title and body of every active story's issue, for example after a template change. */
export const runDrafts = async (deps: DraftDeps, onlyStoryId?: string, refreshIssues = false): Promise<DraftReport> => {
  const report = { revisions: 0, issuesCreated: 0, issuesUpdated: 0, deferred: 0, problems: [] as string[] };
  const stories = (await deps.stores.stories.listByStatus(ACTIVE_STATUSES, 100)).filter(
    (s) => onlyStoryId === undefined || s.id === onlyStoryId,
  );
  // Everything the loop needs, read once for all stories: the Sheet cost stays flat as stories pile up.
  const ids = stories.map((s) => s.id);
  const [issueNumbers, decisionsByStory, itemsByStory, drafts, evidenceByStory] = await Promise.all([
    deps.stores.reviewThreads.issueNumbersFor(ids),
    deps.stores.decisions.listForStories(ids),
    deps.stores.sourceItems.listForStories(ids),
    deps.stores.drafts.latestForStories(ids),
    deps.stores.evidence.listForStories(ids),
  ]);

  // Highest priority first (power cuts lead), then the newest.
  const order = (a: Story, b: Story): number => b.priority - a.priority || Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt);
  for (const initial of stories.sort(order)) {
    let story = initial;
    let issueNumber = issueNumbers.get(story.id);
    if (issueNumber === undefined && onlyStoryId === undefined && report.issuesCreated >= MAX_NEW_ISSUES_PER_RUN) {
      report.deferred += 1;
      continue;
    }
    const decisions = decisionsByStory.get(story.id) ?? [];
    const items = itemsByStory.get(story.id) ?? [];
    let draft = drafts.get(story.id);
    let changed = issueNumber === undefined || onlyStoryId !== undefined || refreshIssues;

    const request = captionRequest(decisions);
    if (request !== undefined && (draft === undefined || request.requestedAt > draft.createdAt)) {
      const built = await buildRevision(deps, story, request, items, draft);
      if (built.ok) {
        draft = built.draft;
        const next = transition(story, { type: "draft_revision", at: toIso(deps.clock.now()) });
        if (next.ok) {
          const saved = await deps.stores.stories.update(next.value, story.version);
          if (saved.ok) story = saved.value;
        }
        report.revisions += 1;
        changed = true;
      } else {
        report.problems.push(`${story.id}: ${built.message}`);
        if (issueNumber !== undefined) await deps.issues.comment(issueNumber, `Could not make the new revision: ${built.message}`);
      }
    }
    if (!changed) continue;

    const evidence = evidenceByStory.get(story.id) ?? [];
    const checks: string[] = [];
    if (draft === undefined) {
      checks.push("No caption yet. Reply with `/caption`: the first line is the headline, each following line is one fact.");
    } else {
      const v = validateCaption({ headlineTa: draft.headlineTa, caption: composeCaption(draft), altText: draft.altText });
      checks.push(`Caption ${v.stats.chars}/1800 characters, ${v.stats.hashtags} hashtags, ${v.stats.mentions} mentions, Tamil ${Math.round(v.stats.tamilShare * 100)}%`);
      for (const p of v.problems) checks.push(`⚠ ${p}`);
    }
    if (story.expiresAt !== undefined) checks.push(`Notice expires ${story.expiresAt}; it will not be published after that.`);
    const sources: IssueSource[] = items.map((i, index) => {
      const source = deps.sourceFor(i.sourceId);
      return {
        name: source?.name ?? i.sourceId,
        title: i.title,
        url: i.canonicalUrl,
        trustTier: source?.trustTier ?? "T3_other",
        relation: index === 0 ? "primary" : "corroborating",
        ...(i.publishedAt === undefined ? {} : { publishedAt: i.publishedAt }),
      };
    });
    const previewUrl = draft?.renderKey === undefined ? undefined : await deps.objects.publicUrl(draft.renderKey);
    const body = renderIssueBody({
      story,
      ...(draft === undefined ? {} : { draft }),
      verificationLevel: deriveVerificationLevel(evidence),
      sources,
      checks,
      possibleDuplicates: [],
      ...(previewUrl === undefined ? {} : { previewUrl }),
    });

    const title = renderIssueTitle(story, draft, items[0]?.title);
    if (issueNumber === undefined) {
      const found = await deps.issues.findByMarker(STORY_LABEL, storyMarker(story.id));
      if (found.ok && found.value !== undefined) issueNumber = found.value.number;
    }
    if (issueNumber === undefined) {
      const created = await deps.issues.create(title, body, [STORY_LABEL]);
      if (!created.ok) {
        report.problems.push(`${story.id}: ${created.error}`);
        continue;
      }
      issueNumber = created.value.number;
      report.issuesCreated += 1;
    } else {
      const updated = await deps.issues.update(issueNumber, title, body);
      if (!updated.ok) {
        report.problems.push(`${story.id}: ${updated.error}`);
        continue;
      }
      report.issuesUpdated += 1;
    }
    await deps.stores.reviewThreads.save(story.id, issueNumber, draft?.revision ?? 0);
  }
  return report;
};
