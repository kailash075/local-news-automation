import { canTransition, type StoryEventType } from "../domain/story-state.ts";
import type {
  DecisionKind,
  DraftRevision,
  EditorialDecision,
  GitHubLogin,
  IsoDateTime,
  Sha256Hex,
  Story,
  VerificationLevel,
} from "../domain/types.ts";
import { meetsMinimum, minimumFor } from "../domain/verification.ts";
import { assertNever, err, ok, type Result } from "../lib/result.ts";
import { formatIst, insideWindow, nextIstTime, toIso, type PostingWindow } from "../publishing/ist.ts";
import type { ReviewCommand } from "./commands.ts";
import { shortHash } from "./revision-hash.ts";

/** GitHub `author_association` values that may issue commands, in addition to the editor allowlist. */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type CommandContext = {
  commenterLogin: string;
  /** `comment.author_association` from the webhook payload. */
  authorAssociation: string;
  editors: readonly GitHubLogin[];
  ownerLogin?: GitHubLogin;
  story: Story;
  /** The latest draft revision, if any. Approvals must name exactly this revision. */
  currentDraft?: DraftRevision;
  verificationLevel: VerificationLevel;
  postingWindow: PostingWindow;
  approvalTtlHours: number;
  now: Date;
};

export type AuthorisedCommand = {
  command: ReviewCommand;
  decisionKind: DecisionKind;
  editorLogin: GitHubLogin;
  /** Full hash of the approved revision, for approvals and schedules. */
  revisionHash?: Sha256Hex;
  scheduledFor?: IsoDateTime;
  /** The story lifecycle event this command causes, if any. */
  storyEvent?: StoryEventType;
};

export type RefusalKind =
  | "not_editor"
  | "owner_only"
  | "wrong_state"
  | "no_draft"
  | "not_rendered"
  | "stale_revision"
  | "needs_sensitive_approval"
  | "insufficient_verification"
  | "invalid_schedule";

export type Refusal = {
  kind: RefusalKind;
  message: string;
  /** False for commenters outside the allowlist: the attempt is recorded but not answered. */
  reply: boolean;
};

const refuse = (kind: RefusalKind, message: string): Result<never, Refusal> =>
  err({ kind, message, reply: kind !== "not_editor" });

export const decisionKindOf = (command: ReviewCommand): DecisionKind => {
  switch (command.kind) {
    case "caption":
    case "headline":
    case "approve":
    case "approve_sensitive":
    case "schedule":
    case "attest":
    case "hold":
    case "unhold":
    case "reject":
    case "retract":
    case "killswitch_on":
    case "killswitch_off":
      return command.kind;
    default:
      return assertNever(command);
  }
};

export const authorise = (command: ReviewCommand, ctx: CommandContext): Result<AuthorisedCommand, Refusal> => {
  const editor = ctx.editors.find((e) => e === ctx.commenterLogin);
  if (editor === undefined || !TRUSTED_ASSOCIATIONS.has(ctx.authorAssociation)) {
    return refuse("not_editor", `@${ctx.commenterLogin} is not an allowlisted editor; command ignored.`);
  }
  const base = { command, decisionKind: decisionKindOf(command), editorLogin: editor };
  const { story } = ctx;

  const needState = (event: StoryEventType): Result<AuthorisedCommand, Refusal> | undefined =>
    canTransition(story.status, event)
      ? undefined
      : refuse("wrong_state", `/${command.kind.replace("_", "-")} is not possible while the story is ${story.status}.`);

  switch (command.kind) {
    case "killswitch_on":
      return ok(base);

    case "killswitch_off":
      if (ctx.ownerLogin === undefined || editor !== ctx.ownerLogin) {
        return refuse("owner_only", "Only the owner can switch the kill switch off.");
      }
      return ok(base);

    case "caption":
    case "headline":
      return needState("draft_revision") ?? ok({ ...base, storyEvent: "draft_revision" });

    case "attest":
      if (["discarded", "rejected", "published", "retracted"].includes(story.status)) {
        return refuse("wrong_state", `Cannot attest a story that is ${story.status}.`);
      }
      return ok(base);

    case "hold":
      return needState("hold") ?? ok({ ...base, storyEvent: "hold" });
    case "unhold":
      return needState("unhold") ?? ok({ ...base, storyEvent: "unhold" });
    case "reject":
      return needState("reject") ?? ok({ ...base, storyEvent: "reject" });
    case "retract":
      return needState("retract") ?? ok({ ...base, storyEvent: "retract" });

    case "approve":
    case "approve_sensitive": {
      const blocked = needState("approve");
      if (blocked !== undefined) return blocked;
      const checked = checkApproval(command.kind, command.rev, ctx);
      if (!checked.ok) return checked;
      return ok({ ...base, revisionHash: checked.value, storyEvent: "approve" });
    }

    case "schedule": {
      // From review: approve and schedule in one step (R0/R1 only). From approved: set the time for the approved revision.
      const fromReview = story.status === "in_review";
      if (!fromReview && story.status !== "approved") {
        return refuse("wrong_state", `/schedule is not possible while the story is ${story.status}.`);
      }
      const checked = checkApproval(fromReview ? "approve" : "approve_sensitive", command.rev, ctx);
      if (!checked.ok) return checked;
      const at = nextIstTime(ctx.now, command.time.hour, command.time.minute);
      if (!insideWindow(at, ctx.postingWindow)) {
        return refuse("invalid_schedule", `${formatIst(at)} is outside the posting window.`);
      }
      if (at.getTime() - ctx.now.getTime() > ctx.approvalTtlHours * 3_600_000) {
        return refuse("invalid_schedule", `${formatIst(at)} is more than ${ctx.approvalTtlHours} hours away; the approval would expire first.`);
      }
      return ok({
        ...base,
        revisionHash: checked.value,
        scheduledFor: toIso(at),
        ...(fromReview ? { storyEvent: "approve" as const } : {}),
      });
    }

    default:
      return assertNever(command);
  }
};

/** Shared checks for approving revision `rev`. Returns the full hash of the current revision. */
const checkApproval = (
  kind: "approve" | "approve_sensitive",
  rev: string,
  ctx: CommandContext,
): Result<Sha256Hex, Refusal> => {
  const draft = ctx.currentDraft;
  if (draft === undefined) return refuse("no_draft", "There is no draft to approve yet. Add one with /caption.");
  if (draft.renderSha256 === undefined) return refuse("not_rendered", "The graphic for this revision has not been rendered yet.");
  const current = shortHash(draft.revisionHash);
  if (rev !== current) {
    return refuse("stale_revision", `Revision ${rev} is not the current revision. The current revision is ${current}.`);
  }
  const { riskTier, disputed } = ctx.story;
  if (kind === "approve" && (riskTier === "R2_SENSITIVE" || disputed)) {
    return refuse(
      "needs_sensitive_approval",
      `This story is ${disputed ? "disputed" : "sensitive (R2)"}. Go through the checklist, then use /approve-sensitive ${current}.`,
    );
  }
  if (!meetsMinimum(ctx.verificationLevel, riskTier, disputed)) {
    const needed = minimumFor(riskTier, disputed);
    const hint = ctx.verificationLevel === "V0_UNVERIFIED" ? " Record how you verified it with /attest first." : "";
    return refuse("insufficient_verification", `Verification is ${ctx.verificationLevel}; this story needs at least ${needed}.${hint}`);
  }
  return ok(draft.revisionHash);
};

/** An approval stops counting after the TTL, so stale news gets a fresh look. */
export const isApprovalExpired = (decision: Pick<EditorialDecision, "createdAt">, now: Date, ttlHours: number): boolean =>
  now.getTime() - Date.parse(decision.createdAt) > ttlHours * 3_600_000;
