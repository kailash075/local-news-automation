import type { Env } from "../config/env.ts";
import { composeCaption } from "../captions/caption.ts";
import type { Clock, ObjectStore, Stores } from "../domain/ports.ts";
import { transition, type StoryEventType } from "../domain/story-state.ts";
import type {
  DraftRevision,
  IsoDateTime,
  Publication,
  PublicationId,
  Sha256Hex,
  Story,
  StoryId,
} from "../domain/types.ts";
import { deriveVerificationLevel } from "../domain/verification.ts";
import { assertNever } from "../lib/result.ts";
import { sha256Hex } from "../review/revision-hash.ts";
import { actionFor, backoffMs, classifyError, describeClientError, MAX_TRANSIENT_ATTEMPTS, type ErrorClass } from "./errors.ts";
import { evaluateGates, type GateCode, type GateReason } from "./gates.ts";
import { startOfIstDay, toIso } from "./ist.ts";
import type { ContainerStatus, InstagramClient, InstagramClientError, RecentMedia } from "./instagram-client.ts";

/**
 * Publisher (docs/ARCHITECTURE.md §5.10). One publication per run, to respect spacing.
 * The container is Meta's own idempotency key: it can be published only once, so its status is checked
 * before any retry, and media_publish is never repeated while the outcome is unknown.
 */

export const LEASE_MS = 10 * 60_000;
export const CONTAINER_MAX_AGE_MS = 24 * 3600_000;
export const MAX_STATUS_POLLS = 5;
export const POLL_INTERVAL_MS = 60_000;
/** Instagram's documented minimum; used only when the live quota omits its total. */
export const FALLBACK_QUOTA_TOTAL = 50;
const DUPLICATE_LOOKBACK_MS = 7 * 24 * 3600_000;
const RECONCILE_SLACK_MS = 5 * 60_000;
const DRY_RUN_RECHECK_MS = 6 * 3600_000;
const OPERATIONAL_RETRY_MS = 15 * 60_000;
const HUMAN_RETRY_MS = 60 * 60_000;
const QUOTA_RETRY_MS = 60 * 60_000;

export type PublisherEnv = Pick<
  Env,
  | "DRY_RUN"
  | "PUBLISHING_ENABLED"
  | "POSTING_WINDOW_IST"
  | "MAX_POSTS_PER_DAY"
  | "MIN_MINUTES_BETWEEN_POSTS"
  | "APPROVAL_TTL_HOURS"
  | "EDITOR_GITHUB_LOGINS"
>;

/** Checks that need other modules (caption validators, storage bytes, near-duplicate search). */
export type ContentChecks = {
  validation: { passed: boolean; problems: readonly string[] };
  /** SHA-256 of the JPEG bytes currently in storage under `draft.renderKey`. */
  storedRenderSha256: Sha256Hex | undefined;
  nearDuplicate: { found: boolean; overriddenByEditor: boolean; detail?: string };
};

export type PublisherDeps = {
  env: PublisherEnv;
  stores: Pick<Stores, "settings" | "publications" | "tokens" | "stories" | "drafts" | "decisions" | "evidence">;
  objects: Pick<ObjectStore, "publicUrl">;
  createClient: (accessToken: string) => InstagramClient;
  checkContent: (story: Story, draft: DraftRevision) => Promise<ContentChecks>;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  leaseOwner: string;
};

export type PublishOutcome =
  | { kind: "idle" }
  | { kind: "blocked"; publicationId: PublicationId; reasons: readonly GateReason[]; cancelled: boolean }
  | { kind: "would_publish"; publicationId: PublicationId; notes: readonly string[] }
  | { kind: "pending_container"; publicationId: PublicationId }
  | { kind: "published"; publicationId: PublicationId; mediaId: string; permalink?: string; reconciled: boolean }
  | { kind: "publish_unknown"; publicationId: PublicationId }
  | { kind: "retry_scheduled"; publicationId: PublicationId; errorClass: ErrorClass; nextAttemptAt: IsoDateTime }
  | { kind: "failed"; publicationId: PublicationId; errorClass: ErrorClass | "container_error"; message: string }
  | { kind: "kill_switch_tripped"; publicationId: PublicationId; reason: string }
  | { kind: "lease_lost"; publicationId: PublicationId; note?: string };

/** Defined with the caption layout; re-exported because reconciliation depends on the exact text. */
export { composeCaption };

export const normaliseCaption = (caption: string): string => caption.normalize("NFC").replace(/\s+/g, " ").trim();

export const idempotencyKeyFor = (storyId: StoryId, revisionHash: Sha256Hex, igAccount: string): Sha256Hex =>
  sha256Hex(`${storyId}:${revisionHash}:${igAccount}`);

/** A new pending publication for an approved draft. Store it with `PublicationStore.createIfAbsent`. */
export const newPublication = (p: {
  id: PublicationId;
  story: Story;
  draft: DraftRevision;
  scheduledFor: IsoDateTime;
  igAccount: string;
}): Publication => ({
  id: p.id,
  storyId: p.story.id,
  draftId: p.draft.id,
  idempotencyKey: idempotencyKeyFor(p.story.id, p.draft.revisionHash, p.igAccount),
  status: "pending",
  scheduledFor: p.scheduledFor,
  attempts: 0,
});

/** Meta returns offsets such as +0000; Date.parse wants +00:00. */
const parseMetaTime = (timestamp: string): number => Date.parse(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

export const findMediaByCaption = (media: readonly RecentMedia[], caption: string, notBefore: Date): RecentMedia | undefined => {
  const wanted = normaliseCaption(caption);
  return media.find(
    (m) => m.caption !== undefined && normaliseCaption(m.caption) === wanted && parseMetaTime(m.timestamp) >= notBefore.getTime(),
  );
};

const withoutContainer = (p: Publication): Publication => {
  const copy = { ...p };
  delete copy.containerId;
  delete copy.containerCreatedAt;
  return copy;
};

const TERMINAL_GATES: ReadonlySet<GateCode> = new Set(["superseded", "already_published", "approval_expired", "story_state"]);
const OPERATIONAL_GATES: ReadonlySet<GateCode> = new Set(["kill_switch", "outside_window", "spacing", "daily_cap", "quota", "token"]);

const errorFields = (e: InstagramClientError): { httpStatus?: number; errorCode?: number; errorSubcode?: number } =>
  e.kind === "api_error"
    ? {
        httpStatus: e.httpStatus,
        ...(e.code === undefined ? {} : { errorCode: e.code }),
        ...(e.subcode === undefined ? {} : { errorSubcode: e.subcode }),
      }
    : e.kind === "ambiguous" && e.httpStatus !== undefined
      ? { httpStatus: e.httpStatus }
      : {};

// ---------------------------------------------------------------- shared run context

type RunContext = {
  deps: Pick<PublisherDeps, "stores" | "clock" | "leaseOwner">;
  pub: Publication;
};

const nowIso = (ctx: RunContext): IsoDateTime => toIso(ctx.deps.clock.now());

const save = async (ctx: RunContext, next: Publication): Promise<boolean> => {
  const r = await ctx.deps.stores.publications.save(next, ctx.deps.leaseOwner);
  if (r.ok) ctx.pub = r.value;
  return r.ok;
};

const release = async (ctx: RunContext): Promise<void> => {
  await ctx.deps.stores.publications.release(ctx.pub.id, ctx.deps.leaseOwner);
};

const moveStory = async (ctx: RunContext, events: readonly StoryEventType[]): Promise<void> => {
  for (const type of events) {
    const story = await ctx.deps.stores.stories.get(ctx.pub.storyId);
    if (story === undefined) return;
    const next = transition(story, { type, at: nowIso(ctx) });
    if (!next.ok) return;
    await ctx.deps.stores.stories.update(next.value, story.version);
  }
};

const markPublished = async (
  ctx: RunContext,
  client: InstagramClient,
  mediaId: string,
  permalinkKnown: string | undefined,
  reconciled: boolean,
): Promise<PublishOutcome> => {
  const { stores } = ctx.deps;
  await stores.publications.recordAttempt({
    publicationId: ctx.pub.id,
    step: reconciled ? "reconcile" : "media_publish",
    outcome: "ok",
    detail: `published media ${mediaId}`,
    at: nowIso(ctx),
  });
  const fromStatus = ctx.pub.status;
  const saved = await save(ctx, { ...ctx.pub, status: "published", mediaId, publishedAt: nowIso(ctx) });
  if (!saved) return { kind: "lease_lost", publicationId: ctx.pub.id, note: `post exists as media ${mediaId}; reconcile will record it` };
  let permalink = permalinkKnown;
  if (permalink === undefined) {
    const p = await client.getPermalink(mediaId);
    await stores.publications.recordAttempt({ publicationId: ctx.pub.id, step: "fetch_permalink", outcome: p.ok ? "ok" : "error", at: nowIso(ctx) });
    if (p.ok) permalink = p.value.permalink;
  }
  if (permalink !== undefined) await save(ctx, { ...ctx.pub, permalink });
  await moveStory(ctx, fromStatus === "publish_unknown" ? ["reconciled_published"] : ["published"]);
  await release(ctx);
  return { kind: "published", publicationId: ctx.pub.id, mediaId, reconciled, ...(permalink === undefined ? {} : { permalink }) };
};

// ---------------------------------------------------------------- publishOne

export const publishOne = async (deps: PublisherDeps): Promise<PublishOutcome> => {
  const { stores, env } = deps;
  const now = deps.clock.now();
  const claimed = await stores.publications.claimDue(now, deps.leaseOwner, LEASE_MS);
  if (claimed === undefined) return { kind: "idle" };
  const ctx: RunContext = { deps, pub: claimed };

  const story = await stores.stories.get(claimed.storyId);
  const draft = await stores.drafts.get(claimed.draftId);
  if (story === undefined || draft === undefined) {
    const reasons: GateReason[] = [{ code: "story_state", message: "story or draft not found" }];
    await save(ctx, { ...ctx.pub, status: "cancelled", lastError: reasons[0]?.message ?? "" });
    await release(ctx);
    return { kind: "blocked", publicationId: claimed.id, reasons, cancelled: true };
  }

  const [currentDraft, decisions, evidence, dbSwitch, credentials, published, publishedToday, lastPublishedAt, content] =
    await Promise.all([
      stores.drafts.latestFor(story.id),
      stores.decisions.listFor(story.id),
      stores.evidence.listFor(story.id),
      stores.settings.getSwitch("publishing_enabled"),
      stores.tokens.getInstagram(),
      stores.publications.listByStatus("published"),
      stores.publications.countPublishedSince(startOfIstDay(now)),
      stores.publications.lastPublishedAt(),
      deps.checkContent(story, draft),
    ]);

  const tokenExpiresAt = credentials === undefined ? undefined : new Date(credentials.expiresAt);
  const tokenUsable = tokenExpiresAt !== undefined && tokenExpiresAt.getTime() > now.getTime();
  const client = credentials !== undefined && tokenUsable ? deps.createClient(credentials.accessToken) : undefined;

  // Reading the quota is not a write; it needs a usable token.
  let quota: { usage: number; total: number } | undefined;
  if (client !== undefined && credentials !== undefined) {
    const q = await client.getPublishingLimit(credentials.igUserId);
    if (q.ok) quota = { usage: q.value.quotaUsage, total: q.value.quotaTotal ?? FALLBACK_QUOTA_TOTAL };
  }

  const gates = evaluateGates({
    now,
    switches: { databaseEnabled: dbSwitch.enabled, repoVariableEnabled: env.PUBLISHING_ENABLED, dryRun: env.DRY_RUN },
    story,
    draft,
    currentDraft,
    decisions,
    editors: env.EDITOR_GITHUB_LOGINS,
    approvalTtlHours: env.APPROVAL_TTL_HOURS,
    verificationLevel: deriveVerificationLevel(evidence),
    validation: content.validation,
    storedRenderSha256: content.storedRenderSha256,
    alreadyPublished: published.some((p) => p.storyId === story.id && p.id !== claimed.id),
    nearDuplicate: content.nearDuplicate,
    cadence: {
      window: env.POSTING_WINDOW_IST,
      maxPostsPerDay: env.MAX_POSTS_PER_DAY,
      minMinutesBetweenPosts: env.MIN_MINUTES_BETWEEN_POSTS,
      publishedToday,
      lastPublishedAt,
    },
    quota,
    token: { present: credentials !== undefined, ...(tokenExpiresAt === undefined ? {} : { expiresAt: tokenExpiresAt }) },
  });

  if (!gates.pass) {
    const message = gates.reasons.map((r) => r.message).join("; ");
    await stores.publications.recordAttempt({ publicationId: claimed.id, step: "gates", outcome: "skipped", detail: message, at: nowIso(ctx) });
    const cancelled = gates.reasons.some((r) => TERMINAL_GATES.has(r.code));
    if (cancelled) {
      await save(ctx, { ...ctx.pub, status: "cancelled", lastError: message });
      if (gates.reasons.some((r) => r.code === "approval_expired")) await moveStory(ctx, ["expire"]);
    } else {
      const onlyOperational = gates.reasons.every((r) => OPERATIONAL_GATES.has(r.code));
      const retryAt = new Date(now.getTime() + (onlyOperational ? OPERATIONAL_RETRY_MS : HUMAN_RETRY_MS));
      await save(ctx, { ...ctx.pub, nextAttemptAt: toIso(retryAt), lastError: message });
    }
    await release(ctx);
    return { kind: "blocked", publicationId: claimed.id, reasons: gates.reasons, cancelled };
  }

  if (gates.mode === "would_publish") {
    const detail = `dry run: would publish${gates.notes.length > 0 ? ` (notes: ${gates.notes.join("; ")})` : ""}`;
    await stores.publications.recordAttempt({ publicationId: claimed.id, step: "gates", outcome: "skipped", detail, at: nowIso(ctx) });
    await save(ctx, { ...ctx.pub, nextAttemptAt: toIso(new Date(now.getTime() + DRY_RUN_RECHECK_MS)), lastError: detail });
    await release(ctx);
    return { kind: "would_publish", publicationId: claimed.id, notes: gates.notes };
  }

  // Live from here. The gates guarantee a usable token; this check keeps the types honest and fails closed.
  if (client === undefined || credentials === undefined) {
    await release(ctx);
    return { kind: "blocked", publicationId: claimed.id, reasons: [{ code: "token", message: "no usable token" }], cancelled: false };
  }
  if (story.status === "approved") await moveStory(ctx, ["schedule_publication"]);
  return runLive(ctx, deps, client, credentials.igUserId, draft);
};

const runLive = async (
  ctx: RunContext,
  deps: PublisherDeps,
  client: InstagramClient,
  igUserId: string,
  draft: DraftRevision,
): Promise<PublishOutcome> => {
  const { stores } = deps;
  const caption = composeCaption(draft);
  const now = deps.clock.now();

  // Reuse a container that is less than 24 hours old, unless it expired or failed.
  let containerId = ctx.pub.containerId;
  const createdAt = ctx.pub.containerCreatedAt === undefined ? undefined : Date.parse(ctx.pub.containerCreatedAt);
  if (containerId !== undefined && (createdAt === undefined || now.getTime() - createdAt >= CONTAINER_MAX_AGE_MS)) {
    await save(ctx, withoutContainer(ctx.pub));
    containerId = undefined;
  }

  if (containerId === undefined) {
    // Guard against a post that already exists (an earlier run whose record was lost, or a manual post).
    const recent = await client.listRecentMedia(igUserId, 25);
    if (!recent.ok) return handleFailure(ctx, deps, "reconcile", recent.error);
    const existing = findMediaByCaption(recent.value, caption, new Date(now.getTime() - DUPLICATE_LOOKBACK_MS));
    if (existing !== undefined) return markPublished(ctx, client, existing.id, existing.permalink, true);

    if (draft.renderKey === undefined) {
      return fail(ctx, "fix_required", "draft has no rendered graphic");
    }
    const imageUrl = await deps.objects.publicUrl(draft.renderKey);
    const created = await client.createImageContainer({ igUserId, imageUrl, caption, altText: draft.altText });
    if (!created.ok) return handleFailure(ctx, deps, "create_container", created.error);
    await stores.publications.recordAttempt({
      publicationId: ctx.pub.id,
      step: "create_container",
      outcome: "ok",
      detail: `container ${created.value.containerId}`,
      at: nowIso(ctx),
    });
    containerId = created.value.containerId;
    const saved = await save(ctx, { ...ctx.pub, status: "container_created", containerId, containerCreatedAt: nowIso(ctx) });
    if (!saved) return { kind: "lease_lost", publicationId: ctx.pub.id };
  }

  // Wait for the container: Meta suggests polling about once a minute for at most 5 minutes.
  let status: ContainerStatus | undefined;
  for (let poll = 0; poll < MAX_STATUS_POLLS; poll++) {
    if (poll > 0) await deps.sleep(POLL_INTERVAL_MS);
    const s = await client.getContainerStatus(containerId);
    if (!s.ok) return handleFailure(ctx, deps, "container_status", s.error);
    status = s.value.status;
    if (status !== "IN_PROGRESS") break;
  }

  switch (status) {
    case undefined:
    case "IN_PROGRESS":
      await save(ctx, { ...ctx.pub, nextAttemptAt: toIso(new Date(deps.clock.now().getTime() + OPERATIONAL_RETRY_MS)) });
      await release(ctx);
      return { kind: "pending_container", publicationId: ctx.pub.id };
    case "PUBLISHED":
      return reconcilePublished(ctx, client, igUserId, caption);
    case "EXPIRED":
      await save(ctx, { ...withoutContainer(ctx.pub), status: "pending", nextAttemptAt: nowIso(ctx) });
      await release(ctx);
      return { kind: "retry_scheduled", publicationId: ctx.pub.id, errorClass: "new_container", nextAttemptAt: nowIso(ctx) };
    case "ERROR":
      return fail(ctx, "container_error", "Instagram reported an error for the container; a person must check it");
    case "FINISHED":
      break;
    default:
      return assertNever(status);
  }

  // Gate 1 again, immediately before the irreversible call.
  const recheck = await stores.settings.getSwitch("publishing_enabled");
  if (!recheck.enabled || !deps.env.PUBLISHING_ENABLED || deps.env.DRY_RUN) {
    const reasons: GateReason[] = [{ code: "kill_switch", message: "publishing was switched off before media_publish" }];
    await stores.publications.recordAttempt({ publicationId: ctx.pub.id, step: "gates", outcome: "skipped", detail: reasons[0]?.message ?? "", at: nowIso(ctx) });
    await save(ctx, { ...ctx.pub, nextAttemptAt: toIso(new Date(deps.clock.now().getTime() + OPERATIONAL_RETRY_MS)) });
    await release(ctx);
    return { kind: "blocked", publicationId: ctx.pub.id, reasons, cancelled: false };
  }

  // Record the intent BEFORE the call. If this save fails, the call is not made.
  const requested = await save(ctx, { ...ctx.pub, status: "publish_requested", publishRequestedAt: nowIso(ctx) });
  if (!requested) return { kind: "lease_lost", publicationId: ctx.pub.id };

  const result = await client.publishContainer(igUserId, containerId);
  if (result.ok) return markPublished(ctx, client, result.value.mediaId, undefined, false);

  if (classifyError(result.error) === "ambiguous") {
    await stores.publications.recordAttempt({
      publicationId: ctx.pub.id,
      step: "media_publish",
      outcome: "error",
      detail: describeClientError(result.error),
      ...errorFields(result.error),
      at: nowIso(ctx),
    });
    await save(ctx, { ...ctx.pub, status: "publish_unknown", lastError: describeClientError(result.error) });
    await moveStory(ctx, ["publish_unknown"]);
    await release(ctx);
    return { kind: "publish_unknown", publicationId: ctx.pub.id };
  }
  return handleFailure(ctx, deps, "media_publish", result.error);
};

const reconcilePublished = async (ctx: RunContext, client: InstagramClient, igUserId: string, caption: string): Promise<PublishOutcome> => {
  const since = ctx.pub.publishRequestedAt ?? ctx.pub.containerCreatedAt;
  const notBefore = new Date((since === undefined ? 0 : Date.parse(since)) - RECONCILE_SLACK_MS);
  const recent = await client.listRecentMedia(igUserId, 25);
  const match = recent.ok ? findMediaByCaption(recent.value, caption, notBefore) : undefined;
  if (match !== undefined) return markPublished(ctx, client, match.id, match.permalink, true);
  await ctx.deps.stores.publications.recordAttempt({
    publicationId: ctx.pub.id,
    step: "reconcile",
    outcome: "error",
    detail: "container is PUBLISHED but the post was not found by caption",
    at: nowIso(ctx),
  });
  const fromStatus = ctx.pub.status;
  await save(ctx, { ...ctx.pub, status: "publish_unknown", lastError: "container published; post not found yet" });
  if (fromStatus !== "publish_unknown") await moveStory(ctx, ["publish_unknown"]);
  await release(ctx);
  return { kind: "publish_unknown", publicationId: ctx.pub.id };
};

const fail = async (ctx: RunContext, errorClass: ErrorClass | "container_error", message: string): Promise<PublishOutcome> => {
  const fromStatus = ctx.pub.status;
  await save(ctx, { ...ctx.pub, status: "publish_failed", lastError: message });
  await moveStory(ctx, fromStatus === "publish_unknown" ? ["reconciled_not_published", "publish_failed"] : ["publish_failed"]);
  await release(ctx);
  return { kind: "failed", publicationId: ctx.pub.id, errorClass, message };
};

const handleFailure = async (
  ctx: RunContext,
  deps: PublisherDeps,
  step: "create_container" | "container_status" | "media_publish" | "reconcile",
  error: InstagramClientError,
): Promise<PublishOutcome> => {
  const errorClass = classifyError(error);
  const detail = describeClientError(error);
  await deps.stores.publications.recordAttempt({
    publicationId: ctx.pub.id,
    step,
    outcome: "error",
    isTransient: errorClass === "transient",
    detail,
    ...errorFields(error),
    at: nowIso(ctx),
  });
  const now = deps.clock.now();
  // After a definite media_publish error the post does not exist; the next run checks the container status first anyway.
  const restingStatus: Publication["status"] = ctx.pub.containerId === undefined ? "pending" : "container_created";
  const retry = async (delayMs: number, attempts: number): Promise<PublishOutcome> => {
    const nextAttemptAt = toIso(new Date(now.getTime() + delayMs));
    await save(ctx, { ...ctx.pub, status: restingStatus, attempts, nextAttemptAt, lastError: detail });
    await release(ctx);
    return { kind: "retry_scheduled", publicationId: ctx.pub.id, errorClass, nextAttemptAt };
  };

  const action = actionFor(errorClass);
  switch (action) {
    case "retry_with_backoff":
    case "reconcile": {
      // An ambiguous answer to a read or to container creation is harmless (an orphan container expires); retry.
      const attempts = ctx.pub.attempts + 1;
      if (attempts >= MAX_TRANSIENT_ATTEMPTS) return fail(ctx, errorClass, `gave up after ${attempts} attempts: ${detail}`);
      return retry(backoffMs(attempts), attempts);
    }
    case "create_new_container": {
      await save(ctx, { ...withoutContainer(ctx.pub), status: "pending", nextAttemptAt: toIso(now), lastError: detail });
      await release(ctx);
      return { kind: "retry_scheduled", publicationId: ctx.pub.id, errorClass, nextAttemptAt: toIso(now) };
    }
    case "reschedule_after_quota_window":
      return retry(QUOTA_RETRY_MS, ctx.pub.attempts);
    case "fail_and_alert":
      return fail(ctx, errorClass, detail);
    case "trip_kill_switch": {
      const reason = `automatic stop after ${step}: ${detail}`;
      await deps.stores.settings.setSwitch("publishing_enabled", false, "system", reason);
      await save(ctx, { ...ctx.pub, status: restingStatus, nextAttemptAt: toIso(new Date(now.getTime() + HUMAN_RETRY_MS)), lastError: reason });
      await release(ctx);
      return { kind: "kill_switch_tripped", publicationId: ctx.pub.id, reason };
    }
    default:
      return assertNever(action);
  }
};

// ---------------------------------------------------------------- reconcileUnknown

export type ReconcileDeps = Omit<PublisherDeps, "checkContent" | "objects"> & {
  /**
   * Claims one specific publication with a lease. Not yet on the PublicationStore port;
   * see the note in the fork report (proposed `PublicationStore.claimById`).
   */
  claimById: (id: PublicationId, leaseOwner: string, leaseMs: number) => Promise<Publication | undefined>;
};

export type ReconcileReport = {
  checked: number;
  resolvedPublished: number;
  resolvedNotPublished: number;
  unresolved: number;
  killSwitchTripped: boolean;
};

/** Two or more unresolved unknown outcomes stop all publishing until the owner looks. */
export const UNRESOLVED_UNKNOWN_LIMIT = 2;

export const reconcileUnknown = async (deps: ReconcileDeps): Promise<ReconcileReport> => {
  const { stores } = deps;
  const unknowns = await stores.publications.listByStatus("publish_unknown");
  const report: ReconcileReport = { checked: 0, resolvedPublished: 0, resolvedNotPublished: 0, unresolved: 0, killSwitchTripped: false };
  const credentials = await stores.tokens.getInstagram();
  const usable = credentials !== undefined && Date.parse(credentials.expiresAt) > deps.clock.now().getTime();
  const client = usable ? deps.createClient(credentials.accessToken) : undefined;

  for (const u of unknowns) {
    report.checked++;
    const claimed = client === undefined || credentials === undefined ? undefined : await deps.claimById(u.id, deps.leaseOwner, LEASE_MS);
    if (claimed === undefined || client === undefined || credentials === undefined) {
      report.unresolved++;
      continue;
    }
    const ctx: RunContext = { deps, pub: claimed };
    const draft = await stores.drafts.get(claimed.draftId);
    if (claimed.containerId === undefined || draft === undefined) {
      await fail(ctx, "unknown", "unknown publish outcome without a container or draft; a person must check");
      report.unresolved++;
      continue;
    }
    const s = await client.getContainerStatus(claimed.containerId);
    if (!s.ok) {
      await release(ctx);
      report.unresolved++;
      continue;
    }
    switch (s.value.status) {
      case "PUBLISHED": {
        const outcome = await reconcilePublished(ctx, client, credentials.igUserId, composeCaption(draft));
        if (outcome.kind === "published") report.resolvedPublished++;
        else report.unresolved++;
        break;
      }
      case "FINISHED":
        // Not published; safe to publish this container in a later run (its status is checked again first).
        await stores.publications.recordAttempt({ publicationId: u.id, step: "reconcile", outcome: "ok", detail: "container FINISHED: not published", at: nowIso(ctx) });
        await save(ctx, { ...ctx.pub, status: "container_created", nextAttemptAt: nowIso(ctx) });
        await moveStory(ctx, ["reconciled_not_published"]);
        await release(ctx);
        report.resolvedNotPublished++;
        break;
      case "IN_PROGRESS":
        await release(ctx);
        report.unresolved++;
        break;
      case "EXPIRED":
      case "ERROR":
        await fail(ctx, "unknown", `container ${s.value.status} after an unknown publish outcome; a person must check`);
        report.resolvedNotPublished++;
        break;
      default:
        assertNever(s.value.status);
    }
  }

  if (report.unresolved >= UNRESOLVED_UNKNOWN_LIMIT) {
    await stores.settings.setSwitch(
      "publishing_enabled",
      false,
      "system",
      `${report.unresolved} publications have an unknown outcome; check Instagram before switching publishing back on`,
    );
    report.killSwitchTripped = true;
  }
  return report;
};
