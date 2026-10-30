import { randomBytes } from "node:crypto";
import type { Stores } from "../../src/domain/ports.ts";
import { createBridgeClient, type BridgeClient } from "../../src/sheet/bridge.ts";
import { setupSheet } from "../../src/sheet/setup.ts";
import { createSheetStores, syncSources } from "../../src/sheet/stores.ts";
import { testClock, type TestClock } from "./clock.ts";
import { BRIDGE_TEST_KEY, createFakeAppsScript, type FakeAppsScript } from "./fake-apps-script.ts";
import { testSource } from "./fixtures.ts";

export type TestSheet = {
  google: FakeAppsScript;
  bridge: BridgeClient;
  stores: Stores;
  clock: TestClock;
  tokenKey: Uint8Array;
};

export const TEST_BRIDGE_URL = "https://script.google.com/macros/s/TEST-DEPLOYMENT/exec";

/** A fresh fake Google Sheet behind the real bridge code, set up by `setupSheet`, with the test source mirrored. */
export const freshSheet = async (options: { start?: Date; tokenKey?: Uint8Array | null } = {}): Promise<TestSheet> => {
  const google = createFakeAppsScript();
  const bridge = createBridgeClient({ url: TEST_BRIDGE_URL, key: BRIDGE_TEST_KEY, fetch: google.fetch, retryDelaysMs: [] });
  const report = await setupSheet(bridge);
  if (report.selfTestFailures.length > 0) throw new Error(`self test failed: ${JSON.stringify(report.selfTestFailures)}`);
  const clock = testClock(options.start);
  const tokenKey = options.tokenKey ?? new Uint8Array(randomBytes(32));
  const stores = createSheetStores(bridge, options.tokenKey === null ? { clock } : { clock, tokenKey });
  await syncSources(bridge, [testSource()], clock);
  return { google, bridge, stores, clock, tokenKey };
};
