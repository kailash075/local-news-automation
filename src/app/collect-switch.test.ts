import { describe, expect, it } from "vitest";
import { createMemoryStores } from "../../test/support/memory-stores.ts";
import { testClock } from "../../test/support/clock.ts";
import { GitHubLoginSchema } from "../domain/types.ts";
import { applyCollectSwitch, scheduledRunPaused } from "./collect-switch.ts";

const owner = GitHubLoginSchema.parse("kailash075");

describe("collect-switch", () => {
  it("is paused before anyone starts it", async () => {
    const stores = createMemoryStores(testClock());
    expect((await stores.settings.getSwitch("collecting_enabled")).enabled).toBe(false);
  });

  it("lets only the owner start automatic collecting", async () => {
    const stores = createMemoryStores(testClock());
    const refused = await applyCollectSwitch(stores.settings, { collect: "start", actor: "someone" }, owner);
    expect(refused.ok).toBe(false);
    expect((await stores.settings.getSwitch("collecting_enabled")).enabled).toBe(false);
    const accepted = await applyCollectSwitch(stores.settings, { collect: "start", actor: "kailash075" }, owner);
    expect(accepted).toEqual({ ok: true, value: "Automatic collecting: ON" });
    expect(await stores.settings.getSwitch("collecting_enabled")).toMatchObject({ enabled: true, updatedBy: "kailash075", reason: "collect-switch start" });
  });

  it("refuses to start when no owner is configured", async () => {
    const stores = createMemoryStores(testClock());
    expect((await applyCollectSwitch(stores.settings, { collect: "start", actor: "kailash075" }, undefined)).ok).toBe(false);
  });

  it("lets anyone allowed to run the workflow pause it", async () => {
    const stores = createMemoryStores(testClock());
    await applyCollectSwitch(stores.settings, { collect: "start", actor: "kailash075" }, owner);
    const paused = await applyCollectSwitch(stores.settings, { collect: "pause", actor: "someone" }, owner);
    expect(paused).toEqual({ ok: true, value: "Automatic collecting: PAUSED (posting continues)" });
    expect((await stores.settings.getSwitch("collecting_enabled")).enabled).toBe(false);
  });

  it("stops only scheduled runs while paused", async () => {
    const stores = createMemoryStores(testClock());
    expect(await scheduledRunPaused(stores.settings, true)).toBe("not set");
    expect(await scheduledRunPaused(stores.settings, false)).toBeUndefined();
    await applyCollectSwitch(stores.settings, { collect: "start", actor: "kailash075" }, owner);
    expect(await scheduledRunPaused(stores.settings, true)).toBeUndefined();
  });
});
