import { createHash } from "node:crypto";
import { composeCaption } from "../captions/caption.ts";
import { validateCaption } from "../captions/validate.ts";
import type { Clock, ObjectStore, Stores } from "../domain/ports.ts";
import type { DraftRevision, Sha256Hex, Story } from "../domain/types.ts";
import { estimateJaccard, minhashSignature } from "../pipeline/minhash.ts";
import type { ContentChecks, PublishOutcome } from "../publishing/publisher.ts";

/** Same threshold as story clustering: at or above this, two captions describe the same event. */
export const NEAR_DUPLICATE_JACCARD = 0.55;
const DUPLICATE_WINDOW_MS = 7 * 24 * 3600_000;

const sha256Hex = (bytes: Uint8Array): Sha256Hex => createHash("sha256").update(bytes).digest("hex") as Sha256Hex;

/**
 * Content checks run immediately before publishing: house caption rules, the stored JPEG is the approved one,
 * and nothing similar was published in the last 7 days (Coimbatore 360 lesson: the same event from two outlets).
 */
export const createContentChecker =
  (deps: { stores: Pick<Stores, "publications" | "drafts">; objects: Pick<ObjectStore, "get">; clock: Clock }) =>
  async (story: Story, draft: DraftRevision): Promise<ContentChecks> => {
    const caption = composeCaption(draft);
    const report = validateCaption({ headlineTa: draft.headlineTa, caption, altText: draft.altText });

    const bytes = draft.renderKey === undefined ? undefined : await deps.objects.get(draft.renderKey);
    const storedRenderSha256 = bytes === undefined ? undefined : sha256Hex(bytes);

    const since = deps.clock.now().getTime() - DUPLICATE_WINDOW_MS;
    const mine = minhashSignature(caption);
    const matches: string[] = [];
    for (const p of await deps.stores.publications.listByStatus("published")) {
      if (p.storyId === story.id || p.publishedAt === undefined || Date.parse(p.publishedAt) < since) continue;
      const other = await deps.stores.drafts.get(p.draftId);
      if (other === undefined) continue;
      const similarity = estimateJaccard(mine, minhashSignature(composeCaption(other)));
      if (similarity >= NEAR_DUPLICATE_JACCARD) {
        matches.push(`${other.headlineTa} (${p.permalink ?? p.id}, similarity ${similarity.toFixed(2)})`);
      }
    }

    return {
      validation: { passed: report.ok, problems: report.problems },
      storedRenderSha256,
      // No editor override command exists yet, so a near-duplicate always blocks.
      nearDuplicate:
        matches.length === 0 ? { found: false, overriddenByEditor: false } : { found: true, overriddenByEditor: false, detail: matches.join("; ") },
    };
  };

/** One line for the job summary and the story's issue. */
export const describeOutcome = (outcome: PublishOutcome): string => {
  switch (outcome.kind) {
    case "idle":
      return "Nothing is due.";
    case "blocked":
      return `Blocked${outcome.cancelled ? " and cancelled" : ""}: ${outcome.reasons.map((r) => r.message).join("; ")}`;
    case "would_publish":
      return `Dry run: every blocking gate passed; this would be published now.${outcome.notes.length === 0 ? "" : ` Notes: ${outcome.notes.join("; ")}`}`;
    case "pending_container":
      return "Instagram is still processing the image; the next run continues.";
    case "published":
      return `Published${outcome.reconciled ? " (confirmed by reconciliation)" : ""}: ${outcome.permalink ?? outcome.mediaId}`;
    case "publish_unknown":
      return "The publish request was sent but the result is unknown. It will be reconciled; it is never retried blindly.";
    case "retry_scheduled":
      return `Temporary error (${outcome.errorClass}); next attempt at ${outcome.nextAttemptAt}.`;
    case "failed":
      return `Failed (${outcome.errorClass}): ${outcome.message}`;
    case "kill_switch_tripped":
      return `Publishing was switched off automatically: ${outcome.reason}. Only the owner can switch it back on.`;
    case "lease_lost":
      return `Another run took over this publication.${outcome.note === undefined ? "" : ` ${outcome.note}`}`;
  }
};
