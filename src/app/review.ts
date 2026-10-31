import { uuidv7 } from "../lib/ids.ts";
import type { Env } from "../config/env.ts";
import type { Clock, Stores } from "../domain/ports.ts";
import { transition } from "../domain/story-state.ts";
import { GitHubLoginSchema, PublicationIdSchema, type EditorialDecision } from "../domain/types.ts";
import { deriveVerificationLevel } from "../domain/verification.ts";
import type { WorkflowDispatcher } from "../github/dispatch.ts";
import { toIso } from "../publishing/ist.ts";
import { newPublication } from "../publishing/publisher.ts";
import { authorise } from "../review/authorise.ts";
import { describeParseError, parseCommand, type ReviewCommand } from "../review/commands.ts";
import { shortHash } from "../review/revision-hash.ts";

export type CommentInput = {
  body: string;
  commentId: number;
  author: string;
  authorAssociation: string;
  issueNumber: number;
};

export type ReviewDeps = {
  env: Pick<
    Env,
    | "EDITOR_GITHUB_LOGINS"
    | "OWNER_GITHUB_LOGIN"
    | "APPROVAL_TTL_HOURS"
    | "POSTING_WINDOW_IST"
    | "PAUSED"
    | "PUBLISH_ON_APPROVAL"
    | "IG_USERNAME"
  >;
  /** The LIVE file exists in the repository root (src/config/live.ts). */
  live: boolean;
  stores: Pick<Stores, "settings" | "stories" | "drafts" | "evidence" | "decisions" | "reviewThreads" | "publications">;
  clock: Clock;
  dispatch: WorkflowDispatcher;
};

/**
 * `reply` is posted back on the issue; undefined means stay silent (for example, a non-editor). `reopen`: an expired
 * story is back in review, so its closed issue opens again.
 */
export type ReviewResult = { reply?: string; dispatched: readonly string[]; reopen?: true };

const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const isEditor = (deps: ReviewDeps, input: CommentInput): boolean =>
  TRUSTED.has(input.authorAssociation) && deps.env.EDITOR_GITHUB_LOGINS.some((e) => e === input.author);

/** Why nothing would be posted right now, or undefined when the LIVE file, PAUSED and the kill switch all allow it. */
const postingStoppedBy = async (deps: ReviewDeps): Promise<string | undefined> => {
  if (!deps.live) return "not live yet (there is no LIVE file in the repository root)";
  if (deps.env.PAUSED) return "the repository variable PAUSED is true";
  if ((await deps.stores.settings.getSwitch("kill_switch")).enabled) return "the kill switch is on";
  return undefined;
};

const killSwitch = async (
  deps: ReviewDeps,
  input: CommentInput,
  command: Extract<ReviewCommand, { kind: "killswitch_on" | "killswitch_off" }>,
): Promise<ReviewResult> => {
  if (!isEditor(deps, input)) return { dispatched: [] };
  if (command.kind === "killswitch_on") {
    await deps.stores.settings.setSwitch("kill_switch", true, input.author, `/killswitch on #${input.issueNumber}: ${command.reason}`);
    return { reply: "🛑 Kill switch **ON**: nothing is posted for any story. Only the owner can switch it off.", dispatched: [] };
  }
  if (deps.env.OWNER_GITHUB_LOGIN === undefined || input.author !== deps.env.OWNER_GITHUB_LOGIN) {
    return { reply: "Only the owner can switch the kill switch off.", dispatched: [] };
  }
  await deps.stores.settings.setSwitch("kill_switch", false, input.author, `/killswitch off #${input.issueNumber}`);
  const stillStopped = await postingStoppedBy(deps);
  return { reply: `Kill switch **OFF**.${stillStopped === undefined ? "" : ` Nothing is posted yet: ${stillStopped}.`}`, dispatched: [] };
};

export const handleComment = async (deps: ReviewDeps, input: CommentInput): Promise<ReviewResult> => {
  const parsed = parseCommand(input.body);
  if (!parsed.ok) {
    if (parsed.error.kind === "not_a_command" || !isEditor(deps, input)) return { dispatched: [] };
    return { reply: `Command not understood: ${describeParseError(parsed.error)}`, dispatched: [] };
  }
  const command = parsed.value;
  if (command.kind === "killswitch_on" || command.kind === "killswitch_off") return killSwitch(deps, input, command);

  const storyId = await deps.stores.reviewThreads.getStoryId(input.issueNumber);
  if (storyId === undefined) {
    return isEditor(deps, input) ? { reply: "This issue is not linked to a story.", dispatched: [] } : { dispatched: [] };
  }
  const story = await deps.stores.stories.get(storyId);
  if (story === undefined) return { reply: "The story for this issue was not found in the Sheet.", dispatched: [] };

  // GitHub can deliver the same event twice; a comment that was already handled is ignored silently.
  if ((await deps.stores.decisions.listFor(story.id)).some((d) => d.githubCommentId === input.commentId)) return { dispatched: [] };

  const now = deps.clock.now();
  const currentDraft = await deps.stores.drafts.latestFor(story.id);
  const verificationLevel = deriveVerificationLevel(await deps.stores.evidence.listFor(story.id));
  const authorised = authorise(command, {
    commenterLogin: input.author,
    authorAssociation: input.authorAssociation,
    editors: deps.env.EDITOR_GITHUB_LOGINS,
    ...(deps.env.OWNER_GITHUB_LOGIN === undefined ? {} : { ownerLogin: deps.env.OWNER_GITHUB_LOGIN }),
    story,
    ...(currentDraft === undefined ? {} : { currentDraft }),
    verificationLevel,
    postingWindow: deps.env.POSTING_WINDOW_IST,
    approvalTtlHours: deps.env.APPROVAL_TTL_HOURS,
    now,
  });
  if (!authorised.ok) return authorised.error.reply ? { reply: `Refused: ${authorised.error.message}`, dispatched: [] } : { dispatched: [] };
  const a = authorised.value;

  const text =
    command.kind === "caption" || command.kind === "headline"
      ? command.text
      : command.kind === "attest"
        ? command.method
        : "reason" in command
          ? command.reason
          : undefined;
  const decision: EditorialDecision = {
    storyId: story.id,
    kind: a.decisionKind,
    editorLogin: a.editorLogin,
    githubCommentId: input.commentId,
    createdAt: toIso(now),
    ...(a.revisionHash === undefined ? {} : { revisionHash: a.revisionHash }),
    ...(a.scheduledFor === undefined ? {} : { scheduledFor: a.scheduledFor }),
    ...(text === undefined ? {} : { reason: text }),
  };
  const { recorded } = await deps.stores.decisions.record(decision);
  if (!recorded) return { dispatched: [] }; // a redelivered comment: already handled

  if (command.kind === "attest") {
    await deps.stores.evidence.add(story.id, {
      kind: "editor_attestation",
      editorLogin: GitHubLoginSchema.parse(a.editorLogin),
      method: command.method,
      attestedAt: toIso(now),
    });
    return { reply: `Verification recorded by @${a.editorLogin} (V3 editor-attested).`, dispatched: [] };
  }

  // A new caption or headline becomes a new revision in draft.yml, which re-renders the card.
  if (command.kind === "caption" || command.kind === "headline") {
    // An expired story comes back for review, with another 48 hours from this command (src/review/expiry.ts).
    const revived = story.status === "expired";
    if (revived) {
      const back = transition(story, { type: "rereview", at: toIso(now) });
      const saved = back.ok ? await deps.stores.stories.update(back.value, story.version) : back;
      if (!saved.ok) return { reply: "The story changed at the same time; please repeat the command.", dispatched: [] };
    }
    const started = await deps.dispatch("draft.yml", { story_id: story.id });
    return {
      reply:
        (revived ? "The expired story is back in review. " : "") +
        (started.ok ? "New revision requested; the card is being re-rendered. Earlier approvals no longer apply." : `Saved, but draft.yml could not be started: ${started.error}`),
      dispatched: started.ok ? ["draft.yml"] : [],
      ...(revived ? { reopen: true as const } : {}),
    };
  }

  if (a.storyEvent !== undefined && a.storyEvent !== "draft_revision") {
    const next = transition(story, { type: a.storyEvent, at: toIso(now) });
    if (!next.ok) return { reply: `Refused: the story cannot move from ${story.status} (${a.storyEvent}).`, dispatched: [] };
    const saved = await deps.stores.stories.update(next.value, story.version);
    if (!saved.ok) return { reply: "The story changed at the same time; please repeat the command.", dispatched: [] };
  }

  if ((command.kind === "approve" || command.kind === "approve_sensitive" || command.kind === "schedule") && currentDraft !== undefined) {
    const scheduledFor = a.scheduledFor ?? toIso(now);
    let publication = await deps.stores.publications.createIfAbsent(
      newPublication({ id: PublicationIdSchema.parse(uuidv7(now)), story, draft: currentDraft, scheduledFor, igAccount: deps.env.IG_USERNAME }),
    );
    if (publication.scheduledFor !== scheduledFor && publication.status === "pending") {
      const owner = `review-${input.commentId}`;
      const claimed = await deps.stores.publications.claimById(publication.id, owner, 60_000);
      if (claimed !== undefined) {
        const saved = await deps.stores.publications.save({ ...claimed, scheduledFor }, owner);
        if (saved.ok) publication = saved.value;
        await deps.stores.publications.release(publication.id, owner);
      }
    }
    const dueNow = Date.parse(publication.scheduledFor) <= now.getTime();
    const when = dueNow ? "as soon as the posting rules allow" : `at ${publication.scheduledFor}`;
    const stopped = await postingStoppedBy(deps);
    const dispatched: string[] = [];
    if (dueNow && deps.env.PUBLISH_ON_APPROVAL && stopped === undefined) {
      const started = await deps.dispatch("publish.yml", { dry_run: "false" });
      if (started.ok) dispatched.push("publish.yml");
    }
    return {
      reply: `✅ Revision ${shortHash(currentDraft.revisionHash)} approved by @${a.editorLogin}. It will be published ${when}, if every gate still passes then.${stopped === undefined ? "" : ` (Nothing is posted yet: ${stopped}.)`}`,
      dispatched,
    };
  }

  const messages: Partial<Record<ReviewCommand["kind"], string>> = {
    hold: "⏸ On hold. Use /unhold to resume.",
    unhold: "▶ Back in review.",
    reject: "Rejected. This story will not be published.",
    retract:
      "Retraction recorded. Delete or correct the post in the Instagram app now (API deletion is not set up), then post a correction if needed.",
  };
  return { reply: messages[command.kind] ?? "Done.", dispatched: [] };
};
