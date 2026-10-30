import { describe, expect, it } from "vitest";
import { createMemoryStores } from "../../test/support/memory-stores.ts";
import { testClock } from "../../test/support/clock.ts";
import { GitHubLoginSchema } from "../domain/types.ts";
import { applySwitch } from "./switch.ts";

const owner = GitHubLoginSchema.parse("kailash075");

describe("switch", () => {
  it("fails closed before anyone sets it", async () => {
    const stores = createMemoryStores(testClock());
    expect((await stores.settings.getSwitch("publishing_enabled")).enabled).toBe(false);
  });
  it("lets only the owner switch publishing on", async () => {
    const stores = createMemoryStores(testClock());
    const refused = await applySwitch(stores.settings, { name: "publishing", state: "on", reason: "go live", actor: "someone" }, owner);
    expect(refused.ok).toBe(false);
    expect((await stores.settings.getSwitch("publishing_enabled")).enabled).toBe(false);
    const accepted = await applySwitch(stores.settings, { name: "publishing", state: "on", reason: "go live", actor: "kailash075" }, owner);
    expect(accepted.ok).toBe(true);
    expect((await stores.settings.getSwitch("publishing_enabled")).enabled).toBe(true);
  });
  it("refuses to switch on when no owner is configured", async () => {
    const stores = createMemoryStores(testClock());
    const result = await applySwitch(stores.settings, { name: "collecting", state: "on", reason: "start", actor: "kailash075" }, undefined);
    expect(result.ok).toBe(false);
  });
  it("lets anyone allowed to run the workflow switch off", async () => {
    const stores = createMemoryStores(testClock());
    await applySwitch(stores.settings, { name: "publishing", state: "on", reason: "go live", actor: "kailash075" }, owner);
    const off = await applySwitch(stores.settings, { name: "publishing", state: "off", reason: "wrong post", actor: "someone" }, owner);
    expect(off.ok).toBe(true);
    expect((await stores.settings.getSwitch("publishing_enabled")).enabled).toBe(false);
  });
});
