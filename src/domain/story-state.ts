import { assertNever, err, ok, type Result } from "../lib/result.ts";
import type { IsoDateTime, Story, StoryStatus } from "./types.ts";

/**
 * Story lifecycle (docs/ARCHITECTURE.md §4). Pure: the caller persists the result with optimistic concurrency.
 * Additions to the diagram, all on the safe side: /hold also works on approved and scheduled stories
 * (unhold returns them to review, so they need a fresh approval), /reject also works on held or approved stories, and a
 * scheduled story expires when the publisher cancels its publication for an old approval or a notice whose day is over.
 */

export type StoryEventType =
  | "triage"
  | "discard"
  | "shortlist"
  | "draft_revision"
  | "approve"
  | "hold"
  | "unhold"
  | "reject"
  | "expire"
  | "rereview"
  | "schedule_publication"
  | "published"
  | "publish_failed"
  | "publish_unknown"
  | "reconciled_published"
  | "reconciled_not_published"
  | "requeue"
  | "retract";

export type StoryEvent = { type: StoryEventType; at: IsoDateTime };

export type TransitionError = { kind: "invalid_transition"; from: StoryStatus; event: StoryEventType };

type Rule = { from: readonly StoryStatus[]; to: StoryStatus };

const ruleFor = (event: StoryEventType): Rule => {
  switch (event) {
    case "triage":
      return { from: ["collected"], to: "triaged" };
    case "discard":
      return { from: ["collected", "triaged"], to: "discarded" };
    case "shortlist":
      return { from: ["triaged"], to: "awaiting_caption" };
    case "draft_revision":
      // A new revision always returns the story to review and cancels any earlier approval.
      return { from: ["awaiting_caption", "in_review", "approved", "expired"], to: "in_review" };
    case "approve":
      return { from: ["in_review"], to: "approved" };
    case "hold":
      return { from: ["in_review", "approved", "scheduled"], to: "on_hold" };
    case "unhold":
      return { from: ["on_hold"], to: "in_review" };
    case "reject":
      return { from: ["in_review", "on_hold", "approved"], to: "rejected" };
    case "expire":
      // Too long without approval (src/review/expiry.ts), an approval older than its TTL, or a notice whose day is over.
      return { from: ["awaiting_caption", "in_review", "on_hold", "approved", "scheduled"], to: "expired" };
    case "rereview":
      return { from: ["expired"], to: "in_review" };
    case "schedule_publication":
      return { from: ["approved"], to: "scheduled" };
    case "published":
      return { from: ["scheduled"], to: "published" };
    case "publish_failed":
      return { from: ["scheduled"], to: "publish_failed" };
    case "publish_unknown":
      return { from: ["scheduled"], to: "publish_unknown" };
    case "reconciled_published":
      return { from: ["publish_unknown"], to: "published" };
    case "reconciled_not_published":
      return { from: ["publish_unknown"], to: "scheduled" };
    case "requeue":
      return { from: ["publish_failed"], to: "scheduled" };
    case "retract":
      return { from: ["published"], to: "retracted" };
    default:
      return assertNever(event);
  }
};

export const transition = (story: Story, event: StoryEvent): Result<Story, TransitionError> => {
  const rule = ruleFor(event.type);
  if (!rule.from.includes(story.status)) {
    return err({ kind: "invalid_transition", from: story.status, event: event.type });
  }
  return ok({ ...story, status: rule.to, version: story.version + 1, updatedAt: event.at });
};

export const canTransition = (status: StoryStatus, event: StoryEventType): boolean => ruleFor(event).from.includes(status);
