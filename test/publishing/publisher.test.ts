import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.ts";
import { PublicationIdSchema } from "../../src/domain/types.ts";
import { toIso } from "../../src/publishing/ist.ts";
import { composeCaption, publishOne, reconcileUnknown } from "../../src/publishing/publisher.ts";
import { approval, credentials, fixtures, json, makeDraft, networkError, TOKEN, world } from "./fakes.ts";

describe("publishOne: happy path", () => {
  it("creates one container, publishes it once, and records the permalink", async () => {
    const w = await world();
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "published", mediaId: fixtures.publish.id, permalink: fixtures.permalink.permalink, reconciled: false });
    expect(w.meta.count("create")).toBe(1);
    expect(w.meta.count("publish")).toBe(1);
    const row = w.publications.rows.get(w.publication.id);
    expect(row?.status).toBe("published");
    expect(row?.leaseOwner).toBeUndefined();
    expect(w.stories.rows.get(w.story.id)?.status).toBe("published");
    const createBody = JSON.parse(w.meta.calls.find((c) => c.endpoint === "create")?.body ?? "{}") as Record<string, string>;
    expect(createBody["caption"]).toBe(composeCaption(w.draft));
    expect(createBody["alt_text"]).toBe(w.draft.altText);
  });

  it("does nothing when no publication is due", async () => {
    const w = await world();
    w.clock.set(new Date("2026-10-30T05:00:00Z")); // before scheduledFor
    expect(await publishOne(w.deps)).toEqual({ kind: "idle" });
    expect(w.meta.calls).toHaveLength(0);
  });
});

describe("kill switch: no Instagram write when any layer is off", () => {
  it.each([
    ["database switch off", { dbSwitch: false }],
    ["repository variable off", { env: { PUBLISHING_ENABLED: false } }],
    ["dry run on", { env: { DRY_RUN: true } }],
  ] as const)("%s", async (_name, options) => {
    const w = await world(options);
    const outcome = await publishOne(w.deps);
    expect(w.meta.writes()).toHaveLength(0);
    expect(["blocked", "would_publish"]).toContain(outcome.kind);
  });

  it("defaults from an empty environment are dry run and publishing off", async () => {
    const defaults = loadEnv({});
    expect(defaults.DRY_RUN).toBe(true);
    expect(defaults.PUBLISHING_ENABLED).toBe(false);
    const w = await world({ env: { DRY_RUN: defaults.DRY_RUN, PUBLISHING_ENABLED: defaults.PUBLISHING_ENABLED } });
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("would_publish");
    expect(w.meta.writes()).toHaveLength(0);
  });

  it("missing token blocks a live run without calling Instagram", async () => {
    const w = await world({ token: undefined });
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "blocked", cancelled: false });
    expect(w.meta.calls).toHaveLength(0);
  });

  it("expired token blocks a live run", async () => {
    const w = await world({ token: credentials({ expiresAt: toIso(new Date("2026-10-29T00:00:00Z")) }) });
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("blocked");
    expect(w.meta.writes()).toHaveLength(0);
  });

  it("dry run reports would_publish, never writes, and notes the switch state", async () => {
    const w = await world({ env: { DRY_RUN: true, PUBLISHING_ENABLED: false }, dbSwitch: false, token: undefined });
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("would_publish");
    if (outcome.kind === "would_publish") expect(outcome.notes.join(" ")).toContain("switched off");
    expect(w.meta.calls).toHaveLength(0);
  });

  it("re-checks the database switch immediately before media_publish", async () => {
    const w = await world();
    // First read is for the gates; the second is the re-check before media_publish.
    w.settings.afterReads = (n) => {
      if (n === 2) w.settings.states.set("publishing_enabled", { enabled: false, reason: "owner stop", updatedBy: "kailash075" });
    };
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "blocked" });
    expect(w.meta.count("create")).toBe(1);
    expect(w.meta.count("publish")).toBe(0);
  });

  it("an outside-window time is blocked and retried later, not cancelled", async () => {
    const w = await world({ now: new Date("2026-10-30T16:00:00Z") }); // 21:30 IST
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "blocked", cancelled: false });
    expect(w.publications.rows.get(w.publication.id)?.nextAttemptAt).toBeDefined();
    expect(w.meta.writes()).toHaveLength(0);
  });
});

describe("approvals bind to one exact revision", () => {
  it("an approval of revision A never publishes revision B", async () => {
    // The publication is for revision 1 (A); the editor then wrote revision 2 (B), so A is superseded.
    const w = await world({ extraDrafts: (story) => [makeDraft(story, { revision: 2, captionTa: "திருத்தப்பட்ட உரை" })] });
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "blocked", cancelled: true });
    if (outcome.kind === "blocked") expect(outcome.reasons.map((r) => r.code)).toContain("superseded");
    expect(w.meta.writes()).toHaveLength(0);
  });

  it("a publication for revision B with only an approval of A is refused", async () => {
    const w = await world({
      decisions: (draft) => {
        const other = makeDraft({ ...draftStory(draft) }, { captionTa: "வேறு உரை" });
        return [approval(other)];
      },
    });
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reasons.map((r) => r.code)).toContain("no_approval");
    expect(w.meta.writes()).toHaveLength(0);
  });

  it("an expired approval cannot publish, and the story expires", async () => {
    const w = await world({ decisions: (draft) => [approval(draft, { createdAt: toIso(new Date("2026-10-29T12:00:00Z")) })] });
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "blocked", cancelled: true });
    if (outcome.kind === "blocked") expect(outcome.reasons.map((r) => r.code)).toContain("approval_expired");
    expect(w.stories.rows.get(w.story.id)?.status).toBe("expired");
    expect(w.meta.writes()).toHaveLength(0);
  });

  it("an R2 story approved with plain /approve is not published", async () => {
    const w = await world({ story: { riskTier: "R2_SENSITIVE" } });
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reasons.map((r) => r.code)).toContain("needs_sensitive_approval");
    expect(w.meta.writes()).toHaveLength(0);
  });

  it("an approval by someone outside the allowlist does not count", async () => {
    const w = await world({ env: { EDITOR_GITHUB_LOGINS: [] } });
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("blocked");
    expect(w.meta.writes()).toHaveLength(0);
  });

  it("a V0 story is not published even when approved", async () => {
    const w = await world({ evidence: [] });
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind === "blocked") expect(outcome.reasons.map((r) => r.code)).toContain("verification");
    expect(w.meta.writes()).toHaveLength(0);
  });
});

describe("unknown outcomes are reconciled, never blindly retried", () => {
  it("an ambiguous media_publish leads to publish_unknown and no second media_publish", async () => {
    const w = await world();
    w.meta.handlers.publish = () => {
      throw networkError("ECONNRESET", "socket hang up");
    };
    expect((await publishOne(w.deps)).kind).toBe("publish_unknown");
    expect(w.stories.rows.get(w.story.id)?.status).toBe("publish_unknown");

    // Later runs do not pick it up for publishing.
    w.clock.advance(60 * 60_000);
    expect((await publishOne(w.deps)).kind).toBe("idle");
    expect(w.meta.count("publish")).toBe(1);

    // Reconciliation finds the post by its caption.
    w.meta.handlers.status = () => json(fixtures.statusPublished);
    w.meta.handlers.media = () =>
      json({ data: [{ id: "17920238422030506", caption: composeCaption(w.draft), timestamp: "2026-10-30T07:31:00+0000", permalink: fixtures.permalink.permalink }] });
    const report = await reconcileUnknown(w.reconcileDeps);
    expect(report).toMatchObject({ checked: 1, resolvedPublished: 1, unresolved: 0, killSwitchTripped: false });
    expect(w.publications.rows.get(w.publication.id)?.status).toBe("published");
    expect(w.stories.rows.get(w.story.id)?.status).toBe("published");
    expect(w.meta.count("publish")).toBe(1);
  });

  it("a FINISHED container after an unknown outcome is published again only after reconciliation", async () => {
    const w = await world();
    w.meta.handlers.publish = () => {
      throw networkError("ECONNRESET");
    };
    await publishOne(w.deps);
    const report = await reconcileUnknown(w.reconcileDeps);
    expect(report.resolvedNotPublished).toBe(1);
    expect(w.publications.rows.get(w.publication.id)?.status).toBe("container_created");

    w.meta.handlers.publish = () => json(fixtures.publish);
    w.clock.advance(31 * 60_000);
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("published");
    expect(w.meta.count("create")).toBe(1); // the same container was reused
    expect(w.meta.count("publish")).toBe(2);
  });

  it("two unresolved unknown outcomes trip the kill switch", async () => {
    const w = await world();
    w.meta.handlers.publish = () => {
      throw networkError("ECONNRESET");
    };
    await publishOne(w.deps);
    // A second unknown publication.
    const second = {
      ...w.publication,
      id: PublicationIdSchema.parse(randomUUID()),
      idempotencyKey: w.draft.revisionHash,
      status: "publish_unknown" as const,
      containerId: "999",
    };
    w.publications.rows.set(second.id, second);
    w.meta.handlers.status = () => json(fixtures.statusInProgress);
    const report = await reconcileUnknown(w.reconcileDeps);
    expect(report.unresolved).toBe(2);
    expect(report.killSwitchTripped).toBe(true);
    expect(w.settings.states.get("publishing_enabled")?.enabled).toBe(false);
  });

  it("a definite server error on media_publish checks the container before any retry", async () => {
    const w = await world();
    w.meta.handlers.publish = () => json(fixtures.errorServer, 500);
    const first = await publishOne(w.deps);
    expect(first).toMatchObject({ kind: "retry_scheduled", errorClass: "transient" });
    expect(w.publications.rows.get(w.publication.id)?.status).toBe("container_created");

    // Meta actually published it after all: the next run sees PUBLISHED and reconciles instead of publishing again.
    w.meta.handlers.status = () => json(fixtures.statusPublished);
    w.meta.handlers.media = () => json({ data: [{ id: "555", caption: composeCaption(w.draft), timestamp: "2026-10-30T06:31:00+0000" }] });
    w.clock.advance(3 * 60_000);
    const second = await publishOne(w.deps);
    expect(second).toMatchObject({ kind: "published", mediaId: "555", reconciled: true });
    expect(w.meta.count("publish")).toBe(1);
  });

  it("does not call media_publish when the lease is lost before the intent is recorded", async () => {
    const w = await world();
    w.meta.handlers.status = () => {
      w.publications.loseLease = true;
      return json(fixtures.statusFinished);
    };
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("lease_lost");
    expect(w.meta.count("publish")).toBe(0);
  });

  it("a post that already exists with the same caption is recorded, not posted again", async () => {
    const w = await world();
    w.meta.handlers.media = () => json({ data: [{ id: "777", caption: composeCaption(w.draft), timestamp: "2026-10-30T06:10:00+0000" }] });
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "published", mediaId: "777", reconciled: true });
    expect(w.meta.writes()).toHaveLength(0);
  });
});

describe("account errors stop all publishing", () => {
  it("a spam error on media_publish trips the database switch", async () => {
    const w = await world();
    w.meta.handlers.publish = () => json(fixtures.errorSpam, 400);
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("kill_switch_tripped");
    const state = w.settings.states.get("publishing_enabled");
    expect(state).toMatchObject({ enabled: false, updatedBy: "system" });

    w.clock.advance(2 * 60 * 60_000);
    const next = await publishOne(w.deps);
    expect(next.kind).toBe("blocked");
    expect(w.meta.count("publish")).toBe(1);
  });

  it("a restricted-account error on container creation trips the switch", async () => {
    const w = await world();
    w.meta.handlers.create = () => json(fixtures.errorRestricted, 400);
    expect((await publishOne(w.deps)).kind).toBe("kill_switch_tripped");
    expect(w.settings.states.get("publishing_enabled")?.enabled).toBe(false);
    expect(w.meta.count("publish")).toBe(0);
  });

  it("an invalid token trips the switch", async () => {
    const w = await world();
    w.meta.handlers.create = () => json(fixtures.errorInvalidToken, 401);
    expect((await publishOne(w.deps)).kind).toBe("kill_switch_tripped");
  });
});

describe("other error classes", () => {
  it("an expired container error clears the container for a new one", async () => {
    const w = await world();
    w.meta.handlers.publish = () => json(fixtures.errorExpiredContainer, 400);
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "retry_scheduled", errorClass: "new_container" });
    expect(w.publications.rows.get(w.publication.id)?.containerId).toBeUndefined();
  });

  it("an unfetchable image fails the publication for a person to fix", async () => {
    const w = await world();
    w.meta.handlers.create = () => json(fixtures.errorImageFetch, 400);
    const outcome = await publishOne(w.deps);
    expect(outcome).toMatchObject({ kind: "failed", errorClass: "fix_required" });
    expect(w.stories.rows.get(w.story.id)?.status).toBe("publish_failed");
  });

  it("a quota error reschedules without failing", async () => {
    const w = await world();
    w.meta.handlers.publish = () => json(fixtures.errorQuota, 400);
    expect(await publishOne(w.deps)).toMatchObject({ kind: "retry_scheduled", errorClass: "quota" });
  });

  it("a full live quota blocks before any write", async () => {
    const w = await world();
    w.meta.handlers.limit = () => json(fixtures.publishingLimitFull);
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("blocked");
    expect(w.meta.writes()).toHaveLength(0);
  });
});

describe("secrets", () => {
  it("the token never appears in attempts, outcomes, settings or request URLs", async () => {
    const w = await world();
    w.meta.handlers.create = () => {
      throw Object.assign(new TypeError(`fetch failed for https://graph.instagram.com/x?access_token=${TOKEN}`), {
        cause: Object.assign(new Error(`reset while sending Bearer ${TOKEN}`), { code: "ECONNRESET" }),
      });
    };
    const first = await publishOne(w.deps);
    w.meta.handlers.create = () => json({ error: { message: `Invalid OAuth access token ${TOKEN}`, type: "OAuthException", code: 190 } }, 401);
    w.clock.advance(60 * 60_000);
    const second = await publishOne(w.deps);

    const everything = JSON.stringify({ first, second, attempts: w.publications.attempts, rows: [...w.publications.rows.values()], settings: [...w.settings.states.values()] });
    expect(everything).not.toContain(TOKEN);
    for (const call of w.meta.calls) expect(call.url).not.toContain(TOKEN);
    expect(w.meta.calls.every((c) => c.headers["authorization"] === `Bearer ${TOKEN}`)).toBe(true);
  });
});

const draftStory = (draft: { storyId: ReturnType<typeof makeDraft>["storyId"] }): Parameters<typeof makeDraft>[0] => ({
  id: draft.storyId,
  status: "approved",
  version: 3,
  topic: "power_cut",
  placeTags: [],
  riskTier: "R0_ROUTINE",
  riskFlags: [],
  disputed: false,
  priority: 1,
  firstSeenAt: toIso(new Date("2026-10-30T02:00:00Z")),
  updatedAt: toIso(new Date("2026-10-30T02:00:00Z")),
});

describe("container states", () => {
  it("keeps waiting while the container is still processing", async () => {
    const w = await world();
    w.meta.handlers.status = () => json(fixtures.statusInProgress);
    expect((await publishOne(w.deps)).kind).toBe("pending_container");
    expect(w.meta.count("status")).toBe(5);
    expect(w.meta.count("publish")).toBe(0);
    expect(w.publications.rows.get(w.publication.id)?.status).toBe("container_created");
  });

  it("an expired container is replaced on the next run", async () => {
    const w = await world();
    w.meta.handlers.status = () => json(fixtures.statusExpired);
    expect(await publishOne(w.deps)).toMatchObject({ kind: "retry_scheduled", errorClass: "new_container" });
    expect(w.publications.rows.get(w.publication.id)?.containerId).toBeUndefined();
    w.meta.handlers.status = () => json(fixtures.statusFinished);
    expect((await publishOne(w.deps)).kind).toBe("published");
    expect(w.meta.count("create")).toBe(2);
    expect(w.meta.count("publish")).toBe(1);
  });

  it("a container in ERROR fails for a person to check", async () => {
    const w = await world();
    w.meta.handlers.status = () => json(fixtures.statusError);
    expect(await publishOne(w.deps)).toMatchObject({ kind: "failed", errorClass: "container_error" });
    expect(w.meta.count("publish")).toBe(0);
  });

  it("a container older than 24 hours is not reused", async () => {
    const w = await world();
    w.meta.handlers.status = () => json(fixtures.statusInProgress);
    await publishOne(w.deps);
    w.clock.advance(25 * 3600_000);
    w.meta.handlers.status = () => json(fixtures.statusFinished);
    w.publications.rows.set(w.publication.id, { ...(w.publications.rows.get(w.publication.id) ?? w.publication), nextAttemptAt: toIso(w.clock.now()) });
    const outcome = await publishOne(w.deps);
    expect(outcome.kind).toBe("blocked"); // the 12-hour approval has also expired by then
    expect(w.meta.count("publish")).toBe(0);
  });

  it("gives up after repeated transient failures", async () => {
    const w = await world();
    w.meta.handlers.create = () => json(fixtures.errorServer, 500);
    let outcome = await publishOne(w.deps);
    for (let i = 0; i < 6 && outcome.kind === "retry_scheduled"; i++) {
      w.clock.advance(40 * 60_000);
      outcome = await publishOne(w.deps);
    }
    expect(outcome).toMatchObject({ kind: "failed", errorClass: "transient" });
    expect(w.publications.rows.get(w.publication.id)?.status).toBe("publish_failed");
  });

  it("a story or draft that disappeared cancels the publication", async () => {
    const w = await world();
    w.stories.rows.delete(w.story.id);
    expect(await publishOne(w.deps)).toMatchObject({ kind: "blocked", cancelled: true });
    expect(w.publications.rows.get(w.publication.id)?.status).toBe("cancelled");
  });
});
