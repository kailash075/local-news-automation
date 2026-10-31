import { describe, expect, it } from "vitest";
import { runDrafts, type DraftDeps } from "../src/app/draft.ts";
import { runTriage } from "../src/app/triage.ts";
import type { IssueRef } from "../src/github/issues.ts";
import { ok } from "../src/lib/result.ts";
import { testClock } from "./support/clock.ts";
import { iso, newSourceItem, testSource } from "./support/fixtures.ts";
import { createMemoryStores } from "./support/memory-stores.ts";

/**
 * Regression (owner decision, 2026-10-31: the repository is public): review issues and run summaries are public, and
 * the newspapers are approved for discovery only, never for reuse of their text or as AI input. A newspaper's headline
 * or excerpt must not reach an issue title, an issue body or a run summary.
 */
describe("newspaper text stays out of public places", () => {
  it("issue titles, issue bodies and the triage summary use our own words and a link", async () => {
    const clock = testClock(new Date("2026-10-31T04:30:00Z"));
    const stores = createMemoryStores(clock);
    const paper = testSource({ trustTier: "T2_established_publisher" });
    const headline = "பெருந்துறையில் ரியல் எஸ்டேட் அதிபரிடம் ரூ.1 கோடி பணம் பறிப்பு";
    const excerpt = "திருப்பூரைச் சோ்ந்த 7 பேரை போலீஸாா் தேடி வருகின்றனா்";
    await stores.sourceItems.insertIfNew(
      newSourceItem("lead", clock.now(), { sourceId: paper.id, title: headline, excerpt, publishedAt: iso(clock.now()) }),
    );

    const triage = await runTriage({ stores, clock, maxAgeHours: 36, sourceFor: () => paper });
    expect(triage.newStories).toBe(1);

    const issues: IssueRef[] = [];
    const client: DraftDeps["issues"] = {
      create: (title, body) => {
        const ref: IssueRef = { number: issues.length + 1, title, body, state: "open" };
        issues.push(ref);
        return Promise.resolve(ok(ref));
      },
      update: () => Promise.resolve(ok(undefined)),
      comment: () => Promise.resolve(ok(undefined)),
      close: () => Promise.resolve(ok(undefined)),
      findByMarker: () => Promise.resolve(ok(undefined)),
    };
    await runDrafts({
      stores,
      clock,
      sourceFor: () => paper,
      objects: { put: () => Promise.resolve(), publicUrl: (key) => Promise.resolve(`https://storage.example/${key}`) },
      issues: client,
      renderer: () => Promise.reject(new Error("no card without a caption")),
    });

    const [issue] = issues;
    expect(issue?.body).toContain("https://example.org/erode/lead");
    for (const published of [issue?.title ?? "", issue?.body ?? "", triage.lines.join("\n")]) {
      expect(published).not.toContain("ரியல் எஸ்டேட்");
      expect(published).not.toContain("போலீஸாா்");
    }
  });
});
