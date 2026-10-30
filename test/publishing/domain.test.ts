import { randomUUID } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { canTransition, transition } from "../../src/domain/story-state.ts";
import {
  GitHubLoginSchema,
  SourceItemIdSchema,
  VerificationEvidenceSchema,
  type VerificationEvidence,
} from "../../src/domain/types.ts";
import { deriveVerificationLevel, meetsMinimum, minimumFor } from "../../src/domain/verification.ts";
import { toIso } from "../../src/publishing/ist.ts";
import { makeStory } from "./fakes.ts";

const item = (): ReturnType<typeof SourceItemIdSchema.parse> => SourceItemIdSchema.parse(randomUUID());
const at = toIso(new Date("2026-10-30T06:00:00Z"));

describe("verification", () => {
  it("derives the strongest level from evidence", () => {
    expect(deriveVerificationLevel([])).toBe("V0_UNVERIFIED");
    expect(deriveVerificationLevel([{ kind: "independent_corroboration", sourceItemIds: [item(), item()] }])).toBe("V1_CORROBORATED");
    expect(
      deriveVerificationLevel([
        { kind: "independent_corroboration", sourceItemIds: [item(), item()] },
        { kind: "official_source", sourceItemId: item() },
      ]),
    ).toBe("V2_OFFICIAL");
    expect(
      deriveVerificationLevel([
        { kind: "official_source", sourceItemId: item() },
        { kind: "editor_attestation", editorLogin: GitHubLoginSchema.parse("kailash075"), method: "Called the EB office at 10:40 IST", attestedAt: at },
      ]),
    ).toBe("V3_EDITOR_ATTESTED");
  });

  it("applies the minimum levels from the editorial policy", () => {
    expect(minimumFor("R0_ROUTINE", false)).toBe("V1_CORROBORATED");
    expect(minimumFor("R1_STANDARD", false)).toBe("V1_CORROBORATED");
    expect(minimumFor("R2_SENSITIVE", false)).toBe("V2_OFFICIAL");
    expect(minimumFor("R0_ROUTINE", true)).toBe("V3_EDITOR_ATTESTED");
    expect(meetsMinimum("V0_UNVERIFIED", "R0_ROUTINE", false)).toBe(false);
    expect(meetsMinimum("V1_CORROBORATED", "R2_SENSITIVE", false)).toBe(false);
    expect(meetsMinimum("V2_OFFICIAL", "R2_SENSITIVE", false)).toBe(true);
    expect(meetsMinimum("V2_OFFICIAL", "R1_STANDARD", true)).toBe(false);
  });

  it("has no AI evidence kind, in the type or at runtime", () => {
    // @ts-expect-error: AI output can never be verification evidence.
    const fake: VerificationEvidence = { kind: "ai", model: "any", confidence: 0.99 };
    expect(VerificationEvidenceSchema.safeParse(fake).success).toBe(false);
    expectTypeOf<Extract<VerificationEvidence, { kind: "ai" }>>().toBeNever();
    expectTypeOf<VerificationEvidence["kind"]>().toEqualTypeOf<"official_source" | "independent_corroboration" | "editor_attestation">();
  });

  it("corroboration needs at least two items", () => {
    expect(VerificationEvidenceSchema.safeParse({ kind: "independent_corroboration", sourceItemIds: [item()] }).success).toBe(false);
  });
});

describe("story lifecycle", () => {
  it("follows the happy path and bumps the version each step", () => {
    let story = makeStory({ status: "collected", version: 0 });
    for (const type of ["triage", "shortlist", "draft_revision", "approve", "schedule_publication", "published"] as const) {
      const next = transition(story, { type, at });
      expect(next.ok).toBe(true);
      if (next.ok) {
        expect(next.value.version).toBe(story.version + 1);
        expect(next.value.updatedAt).toBe(at);
        story = next.value;
      }
    }
    expect(story.status).toBe("published");
  });

  it("rejects invalid events instead of applying them", () => {
    const story = makeStory({ status: "collected" });
    expect(transition(story, { type: "approve", at })).toEqual({
      ok: false,
      error: { kind: "invalid_transition", from: "collected", event: "approve" },
    });
    expect(canTransition("published", "approve")).toBe(false);
    expect(canTransition("rejected", "unhold")).toBe(false);
  });

  it("a new revision cancels an approval", () => {
    const next = transition(makeStory({ status: "approved" }), { type: "draft_revision", at });
    expect(next.ok && next.value.status).toBe("in_review");
  });

  it("an unknown publish outcome is resolved only by reconciliation", () => {
    const unknown = makeStory({ status: "publish_unknown" });
    expect(canTransition("publish_unknown", "published")).toBe(false);
    expect(transition(unknown, { type: "reconciled_published", at }).ok).toBe(true);
    expect(transition(unknown, { type: "reconciled_not_published", at }).ok).toBe(true);
  });

  it("an unhold returns the story to review, so it needs a fresh approval", () => {
    const held = transition(makeStory({ status: "approved" }), { type: "hold", at });
    expect(held.ok && held.value.status).toBe("on_hold");
    if (held.ok) {
      const unheld = transition(held.value, { type: "unhold", at });
      expect(unheld.ok && unheld.value.status).toBe("in_review");
    }
  });
});
