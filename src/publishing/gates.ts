import type { DraftRevision, EditorialDecision, GitHubLogin, Sha256Hex, Story, VerificationLevel } from "../domain/types.ts";
import { meetsMinimum, minimumFor } from "../domain/verification.ts";
import { isApprovalExpired } from "../review/authorise.ts";
import { formatIst, insideWindow, type PostingWindow } from "./ist.ts";

/**
 * Publishing gates (docs/ARCHITECTURE.md §5.10). Pure: the publisher gathers the facts, this decides.
 * Evaluated before container creation; gate 1 is evaluated again immediately before media_publish.
 */

export type GateCode =
  | "not_live"
  | "paused"
  | "kill_switch"
  | "story_state"
  | "superseded"
  | "no_approval"
  | "approval_expired"
  | "needs_sensitive_approval"
  | "editor_not_allowed"
  | "verification"
  | "validation"
  | "render_mismatch"
  | "already_published"
  | "near_duplicate"
  | "outside_window"
  | "spacing"
  | "daily_cap"
  | "quota"
  | "token";

export type GateReason = { code: GateCode; message: string };

export type GateInput = {
  now: Date;
  /** `live`: the LIVE file exists. `paused`: repository variable PAUSED is "true". `killSwitch`: the Sheet's kill switch is on. */
  switches: { live: boolean; paused: boolean; killSwitch: boolean; dryRun: boolean };
  story: Story;
  /** The draft this publication was created for. */
  draft: DraftRevision;
  /** The story's latest draft; it must be the same revision. */
  currentDraft: DraftRevision | undefined;
  decisions: readonly EditorialDecision[];
  editors: readonly GitHubLogin[];
  approvalTtlHours: number;
  verificationLevel: VerificationLevel;
  validation: { passed: boolean; problems: readonly string[] };
  /** SHA-256 of the JPEG bytes in storage, computed at publish time. */
  storedRenderSha256: Sha256Hex | undefined;
  alreadyPublished: boolean;
  nearDuplicate: { found: boolean; overriddenByEditor: boolean; detail?: string };
  cadence: {
    window: PostingWindow;
    maxPostsPerDay: number;
    minMinutesBetweenPosts: number;
    publishedToday: number;
    lastPublishedAt: Date | undefined;
  };
  /** Live `content_publishing_limit`; undefined when it could not be read. */
  quota: { usage: number; total: number } | undefined;
  token: { present: boolean; expiresAt?: Date };
};

export type GateResult =
  | { pass: true; mode: "publish" }
  /** Dry run: everything that decides content and approval passed. Switch, quota and token states are notes. */
  | { pass: true; mode: "would_publish"; notes: readonly string[] }
  | { pass: false; reasons: readonly GateReason[] };

const APPROVAL_KINDS: ReadonlySet<EditorialDecision["kind"]> = new Set(["approve", "approve_sensitive", "schedule"]);

export const switchesAllowPublishing = (s: GateInput["switches"]): boolean => s.live && !s.paused && !s.killSwitch && !s.dryRun;

export const evaluateGates = (input: GateInput): GateResult => {
  const reasons: GateReason[] = [];
  const notes: string[] = [];
  const dry = input.switches.dryRun;
  /** In dry run, operational gates become notes; content and approval gates always block. */
  const operational = (reason: GateReason): void => {
    if (dry) notes.push(reason.message);
    else reasons.push(reason);
  };
  const { story, draft, now } = input;

  // 1. Switches: Coimbatore 360's LIVE file and PAUSED variable, then the kill switch.
  if (!input.switches.live) operational({ code: "not_live", message: "not live yet: there is no LIVE file in the repository root" });
  if (input.switches.paused) operational({ code: "paused", message: "repository variable PAUSED is true" });
  if (input.switches.killSwitch) operational({ code: "kill_switch", message: "the kill switch is on (/killswitch)" });

  // 2. Approval of exactly this revision, current, in time, by an allowlisted editor, of the right kind.
  if (story.status !== "approved" && story.status !== "scheduled") {
    reasons.push({ code: "story_state", message: `story is ${story.status}, not approved` });
  }
  if (input.currentDraft === undefined || input.currentDraft.revisionHash !== draft.revisionHash || input.currentDraft.id !== draft.id) {
    reasons.push({ code: "superseded", message: "a newer revision exists; the approved revision is no longer current" });
  }
  const sensitive = story.riskTier === "R2_SENSITIVE" || story.disputed;
  const approvals = input.decisions.filter((d) => APPROVAL_KINDS.has(d.kind) && d.revisionHash === draft.revisionHash);
  const byEditors = approvals.filter((d) => input.editors.includes(d.editorLogin));
  const ofRightKind = byEditors.filter((d) => !sensitive || d.kind === "approve_sensitive");
  const fresh = ofRightKind.filter((d) => !isApprovalExpired(d, now, input.approvalTtlHours));
  if (approvals.length === 0) {
    reasons.push({ code: "no_approval", message: "no approval recorded for this exact revision" });
  } else if (byEditors.length === 0) {
    reasons.push({ code: "editor_not_allowed", message: "the approval did not come from an allowlisted editor" });
  } else if (ofRightKind.length === 0) {
    reasons.push({ code: "needs_sensitive_approval", message: "sensitive or disputed story needs /approve-sensitive" });
  } else if (fresh.length === 0) {
    reasons.push({ code: "approval_expired", message: `approval is older than ${input.approvalTtlHours} hours` });
  }

  // 3. Verification meets the minimum for the risk tier.
  if (!meetsMinimum(input.verificationLevel, story.riskTier, story.disputed)) {
    reasons.push({
      code: "verification",
      message: `verification ${input.verificationLevel} is below ${minimumFor(story.riskTier, story.disputed)}`,
    });
  }

  // 4. Validation passed and the stored JPEG is the approved one.
  if (!input.validation.passed) {
    reasons.push({ code: "validation", message: `validation failed: ${input.validation.problems.join("; ") || "no report"}` });
  }
  if (draft.renderSha256 === undefined || input.storedRenderSha256 === undefined || draft.renderSha256 !== input.storedRenderSha256) {
    reasons.push({ code: "render_mismatch", message: "stored graphic does not match the approved render" });
  }

  // 5. Not published already; no near-duplicate in the last 7 days unless an editor overrode the check.
  if (input.alreadyPublished) reasons.push({ code: "already_published", message: "this story has already been published" });
  if (input.nearDuplicate.found && !input.nearDuplicate.overriddenByEditor) {
    reasons.push({ code: "near_duplicate", message: `a similar post was published recently${input.nearDuplicate.detail === undefined ? "" : `: ${input.nearDuplicate.detail}`}` });
  }

  // 6. Posting window, spacing, daily cap, live quota.
  const c = input.cadence;
  if (!insideWindow(now, c.window)) operational({ code: "outside_window", message: `${formatIst(now)} is outside the posting window` });
  if (c.lastPublishedAt !== undefined && now.getTime() - c.lastPublishedAt.getTime() < c.minMinutesBetweenPosts * 60_000) {
    operational({ code: "spacing", message: `less than ${c.minMinutesBetweenPosts} minutes since the last post` });
  }
  if (c.publishedToday >= c.maxPostsPerDay) operational({ code: "daily_cap", message: `daily cap of ${c.maxPostsPerDay} posts reached` });
  if (input.quota === undefined) {
    operational({ code: "quota", message: "live publishing quota could not be read" });
  } else if (input.quota.usage >= input.quota.total) {
    operational({ code: "quota", message: `Instagram quota used up (${input.quota.usage}/${input.quota.total})` });
  }

  // 7. Token present and not expired.
  if (!input.token.present) operational({ code: "token", message: "no Instagram token stored" });
  else if (input.token.expiresAt === undefined || input.token.expiresAt.getTime() <= now.getTime()) {
    operational({ code: "token", message: "Instagram token has expired" });
  }

  if (reasons.length > 0) return { pass: false, reasons };
  return dry ? { pass: true, mode: "would_publish", notes } : { pass: true, mode: "publish" };
};
