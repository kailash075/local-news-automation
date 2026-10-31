import type { EditorialDecision, Story, StoryStatus } from "../domain/types.ts";
import { istDateOf } from "../pipeline/freshness.ts";

/**
 * Review expiry (docs/OPERATIONS.md §3): a story that waits too long for an editor is old news, so it expires and its
 * review issue is closed. The 48 hours start when the story arrives and start again with each editor command on it, so a
 * story an editor is working on stays open, and a new /caption brings an expired story back. A notice (power cut, water
 * supply, ...) expires once its stated day is over, whatever the editor did. Approved stories are left to the publisher:
 * their approval has its own lifetime, and the publisher checks the notice date before posting. Pure: `now` is a parameter.
 */

export const REVIEW_TTL_HOURS = 48;

/** Stories waiting for an editor: for a caption, a review, or the end of a hold. */
export const AWAITING_EDITOR: readonly StoryStatus[] = ["awaiting_caption", "in_review", "on_hold"];

export type ExpiryReason = "no_approval" | "notice_passed";

/** The notice's stated day is over (`Story.expiresAt`): it must not be drafted or posted any more. */
export const noticePassed = (story: Pick<Story, "expiresAt">, now: Date): boolean =>
  story.expiresAt !== undefined && now.getTime() > Date.parse(story.expiresAt);

/** Why the story has expired at `now`, or undefined while an editor may still act on it. */
export const reviewExpiry = (
  story: Pick<Story, "status" | "firstSeenAt" | "expiresAt">,
  decisions: readonly Pick<EditorialDecision, "createdAt">[],
  now: Date,
): ExpiryReason | undefined => {
  if (!AWAITING_EDITOR.includes(story.status)) return undefined;
  if (noticePassed(story, now)) return "notice_passed";
  const lastActivity = Math.max(Date.parse(story.firstSeenAt), ...decisions.map((d) => Date.parse(d.createdAt)));
  return now.getTime() - lastActivity >= REVIEW_TTL_HOURS * 3_600_000 ? "no_approval" : undefined;
};

/** The note posted on the review issue just before it is closed. */
export const expiryNote = (reason: ExpiryReason, story: Pick<Story, "expiresAt">): string => {
  if (reason === "notice_passed" && story.expiresAt !== undefined) {
    const d = istDateOf(new Date(story.expiresAt));
    return `⌛ Expired: this notice was for ${d.day}.${d.month}.${d.year}, and that day is over, so it will not be posted.`;
  }
  return `⌛ Expired: not approved within ${REVIEW_TTL_HOURS} hours, so this story will not be posted. To bring it back for review, send a new \`/caption\` here.`;
};
