import { describe, expect, it } from "vitest";
import { BRIDGE_TEST_KEY, createFakeAppsScript } from "../../test/support/fake-apps-script.ts";
import { makeDraft, makePublication, makeStory } from "../../test/support/fixtures.ts";
import { freshSheet, TEST_BRIDGE_URL } from "../../test/support/sheet.ts";
import type { FetchLike } from "../collectors/http.ts";
import { createBridgeClient, type BridgeError } from "./bridge.ts";
import { assertSheetSchema, SELF_TEST_VALUES, setupSheet } from "./setup.ts";
import { createSheetStores } from "./stores.ts";
import { SHEET_SCHEMA_VERSION, TABLES } from "./tables.ts";

const client = (fetchImpl: FetchLike, key = BRIDGE_TEST_KEY, sleeps: number[] = []) =>
  createBridgeClient({
    url: TEST_BRIDGE_URL,
    key,
    fetch: fetchImpl,
    retryDelaysMs: [10, 20],
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

const failure = async (p: Promise<unknown>): Promise<BridgeError> => {
  try {
    await p;
  } catch (error) {
    return error as BridgeError;
  }
  throw new Error("expected a failure");
};

describe("Apps Script bridge", () => {
  it("refuses a wrong key, and every request when BRIDGE_KEY was never created", async () => {
    const google = createFakeAppsScript();
    const wrong = await failure(client(google.fetch, "x".repeat(64)).ping());
    expect(wrong.message).toMatch(/unauthorized/);
    expect(wrong.retryable).toBe(false);

    const unset = createFakeAppsScript({ bridgeKey: null });
    expect((await failure(client(unset.fetch).ping())).message).toMatch(/unauthorized/);
    unset.runFunction("initBridge");
    const created = unset.properties.get("BRIDGE_KEY") ?? "";
    expect(created).toMatch(/^[0-9a-f]{64}$/);
    unset.runFunction("initBridge");
    expect(unset.properties.get("BRIDGE_KEY")).toBe(created);
    await expect(client(unset.fetch, created).ping()).resolves.toMatchObject({ schemaVersion: null });
  });

  it("never sends the key in the URL", async () => {
    const google = createFakeAppsScript();
    const urls: string[] = [];
    await client((url, init) => {
      urls.push(url);
      return google.fetch(url, init);
    }).ping();
    expect(urls).toEqual([TEST_BRIDGE_URL]);
    expect(google.requests[0]).toMatchObject({ op: "ping", auth: BRIDGE_TEST_KEY });
  });

  it("retries while another request holds the lock", async () => {
    const google = createFakeAppsScript();
    google.lockHeld.value = true;
    const sleeps: number[] = [];
    const bridge = createBridgeClient({
      url: TEST_BRIDGE_URL,
      key: BRIDGE_TEST_KEY,
      fetch: google.fetch,
      retryDelaysMs: [10, 20],
      sleep: (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) google.lockHeld.value = false;
        return Promise.resolve();
      },
    });
    await expect(bridge.ping()).resolves.toBeDefined();
    expect(sleeps).toEqual([10, 20]);

    google.lockHeld.value = true;
    const busy = await failure(client(google.fetch).ping());
    expect(busy).toMatchObject({ retryable: true, message: expect.stringMatching(/busy/) as unknown });
  });

  it("retries network errors and server errors, and explains a non-JSON answer", async () => {
    const google = createFakeAppsScript();
    let calls = 0;
    const flaky: FetchLike = (url, init) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
      if (calls === 2) return Promise.resolve(new Response("oops", { status: 502 }));
      return google.fetch(url, init);
    };
    await expect(client(flaky).ping()).resolves.toBeDefined();
    expect(calls).toBe(3);

    const login: FetchLike = () => Promise.resolve(new Response("<html>Sign in</html>", { status: 200 }));
    const html = await failure(client(login).ping());
    expect(html.message).toMatch(/deployed with access "Anyone"/);
    expect(html.message).not.toContain(BRIDGE_TEST_KEY);
  });

  it("does not record a decision twice when a lost answer makes the client retry", async () => {
    const t = await freshSheet();
    const story = makeStory(t.clock.now());
    await t.stores.stories.insert(story);
    let dropNext = true;
    const lossy = createBridgeClient({
      url: TEST_BRIDGE_URL,
      key: BRIDGE_TEST_KEY,
      retryDelaysMs: [0],
      fetch: async (url, init) => {
        const res = await t.google.fetch(url, init);
        if (dropNext) {
          dropNext = false;
          throw new TypeError("socket hang up");
        }
        return res;
      },
    });
    const stores = createSheetStores(lossy, { clock: t.clock });
    const decision = {
      storyId: story.id,
      kind: "approve" as const,
      editorLogin: "kailash075" as never,
      githubCommentId: 99,
      createdAt: story.firstSeenAt,
    };
    expect(await stores.decisions.record(decision)).toEqual({ recorded: true });
    expect(await t.stores.decisions.listFor(story.id)).toHaveLength(1);
    expect(await stores.decisions.record(decision)).toEqual({ recorded: false });
  });

  it("refuses to change append-only tabs, unknown tabs and unknown columns", async () => {
    const t = await freshSheet();
    for (const table of [TABLES.decisions.name, TABLES.evidence.name, TABLES.drafts.name, TABLES.publishAttempts.name, TABLES.errors.name]) {
      expect((await failure(t.bridge.update(table, { id: "x" }, { story_id: "y" }))).message).toMatch(/append-only/);
      expect((await failure(t.bridge.upsert(table, ["id"], { id: "x" }))).message).toMatch(/append-only/);
    }
    expect((await failure(t.bridge.select("passwords"))).message).toMatch(/unknown table passwords/);
    expect((await failure(t.bridge.select("_selftest"))).message).toMatch(/unknown table/);
    expect((await failure(t.bridge.insert(TABLES.stories.name, [{ id: "x", owner: "me" }]))).message).toMatch(/unknown column owner/);
    expect((await failure(t.bridge.update(TABLES.stories.name, {}, { status: "x" }))).message).toMatch(/needs a where clause/);
  });

  it("keeps one live publication per story and one draft per revision", async () => {
    const t = await freshSheet();
    const story = makeStory(t.clock.now());
    await t.stores.stories.insert(story);
    const d1 = makeDraft(story.id, t.clock.now(), 1);
    await t.stores.drafts.insert(d1);
    expect((await failure(t.stores.drafts.insert({ ...makeDraft(story.id, t.clock.now(), 1), revisionHash: d1.revisionHash }))).message).toMatch(
      /drafts_story_revision_unique/,
    );
    await t.stores.drafts.insert(d1);
    await t.stores.publications.createIfAbsent(makePublication(story.id, d1, t.clock.now()));
    const d2 = makeDraft(story.id, t.clock.now(), 2);
    await t.stores.drafts.insert(d2);
    expect((await failure(t.stores.publications.createIfAbsent(makePublication(story.id, d2, t.clock.now())))).message).toMatch(
      /publications_one_live_per_story/,
    );
  });

  it("stores text exactly, so a headline or a source title can never become a formula", async () => {
    const t = await freshSheet();
    const id = "0199f0a0-0000-7000-8000-000000000001";
    const tricky = { id, status: "=HYPERLINK(\"https://evil.example\")", topic: "+91 94430", place_tags: "007", risk_tier: "'x", risk_flags: "2026-10-30" };
    await t.bridge.insert(TABLES.stories.name, [tricky], { unique: ["id"] });
    const [row] = await t.bridge.select(TABLES.stories.name, { id });
    expect(row).toMatchObject(tricky);
    const sheet = t.google.spreadsheet.getSheetByName(TABLES.stories.name);
    const header = sheet?.getRange(1, 1, 1, TABLES.stories.columns.length).getValues()[0] ?? [];
    const statusColumn = header.indexOf("status") + 1;
    expect(sheet?.read(2, statusColumn)).toBe(tricky.status);
  });

  it("grows the tab when rows run out", async () => {
    const t = await freshSheet();
    const rows = Array.from({ length: 1200 }, (_, i) => ({ key: `k${String(i)}`, enabled: "false", reason: "", updated_by: "t", updated_at: "" }));
    await t.bridge.insert(TABLES.settings.name, rows);
    expect(await t.bridge.select(TABLES.settings.name, undefined, ["key"])).toHaveLength(1200);
  });

  it("reads cells the owner typed by hand as text", async () => {
    const t = await freshSheet();
    await t.stores.settings.setSwitch("kill_switch", false, "kailash075", "start");
    const sheet = t.google.spreadsheet.getSheetByName(TABLES.settings.name);
    // Rows the bridge wrote are plain-text cells: a typed TRUE stays the text "TRUE", which is not "true".
    // An unreadable kill switch counts as on.
    sheet?.type(2, 2, "TRUE");
    expect(await t.stores.settings.getSwitch("kill_switch")).toMatchObject({ enabled: true, reason: "invalid stored value" });
    // A row typed below them has automatic format, so Sheets turns the date into a Date; it is read back as text.
    sheet?.type(3, 1, "collecting_enabled");
    sheet?.type(3, 5, "2026-10-30");
    const [, typed] = await t.bridge.select(TABLES.settings.name);
    expect(typed).toMatchObject({ key: "collecting_enabled", updated_at: "2026-10-30T00:00:00.000Z" });
  });

  it("keeps secrets out of the Sheet and refuses to hand out the bridge key", async () => {
    const t = await freshSheet();
    await t.bridge.secretPut("instagram_token", "ciphertext");
    expect(t.google.properties.get("SECRET_instagram_token")).toBe("ciphertext");
    expect(await t.bridge.secretGet("instagram_token")).toBe("ciphertext");
    expect(await t.bridge.secretGet("missing")).toBeUndefined();
    expect((await failure(t.bridge.secretGet("BRIDGE_KEY"))).message).toMatch(/bad secret name/);
    for (const sheet of t.google.spreadsheet.sheets.values()) {
      for (const cell of sheet.cells.values()) expect(String(cell.value)).not.toContain("ciphertext");
    }
  });

  it("runs batches in order and refuses nested or schema operations inside them", async () => {
    const t = await freshSheet();
    const [inserted, selected] = await t.bridge.batch([
      { op: "insert", table: TABLES.settings.name, rows: [{ key: "a", enabled: "true" }] },
      { op: "select", table: TABLES.settings.name, where: { key: "a" }, columns: ["enabled"] },
    ]);
    expect(inserted).toEqual([{ inserted: true }]);
    expect(selected).toEqual([{ enabled: "true" }]);
    const google = createFakeAppsScript();
    const res = await google.fetch(TEST_BRIDGE_URL, {
      method: "POST",
      body: JSON.stringify({ auth: BRIDGE_TEST_KEY, op: "batch", ops: [{ op: "setup", schemaVersion: "x", tables: [] }] }),
    });
    expect(await res.json()).toMatchObject({ ok: false, error: "setup cannot run inside a batch" });
  });
});

describe("Sheet setup", () => {
  it("creates every tab, adds new columns later, and keeps columns the owner added", async () => {
    const google = createFakeAppsScript();
    const bridge = client(google.fetch);
    await expect(assertSheetSchema(bridge)).rejects.toThrow(/not set up.*run the migrate workflow/);

    const first = await setupSheet(bridge);
    expect(first.created).toHaveLength(Object.keys(TABLES).length);
    expect(first.selfTestFailures).toEqual([]);
    expect(google.spreadsheet.getSheetByName("_selftest")).toBeNull();
    await expect(assertSheetSchema(bridge)).resolves.toBeUndefined();

    const sheet = google.spreadsheet.getSheetByName(TABLES.stories.name);
    const extra = TABLES.stories.columns.length + 1;
    sheet?.type(1, extra, "owner notes");
    sheet?.getRange(1, TABLES.stories.columns.length, 1, 1).setValues([[""]]);
    const second = await setupSheet(bridge);
    expect(second.created).toEqual([]);
    expect(second.extended).toEqual([TABLES.stories.name]);
    const header = sheet?.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    expect(header).toContain("owner notes");
    expect(header).toContain(TABLES.stories.columns.at(-1));
  });

  it("reports values that Sheets changed", async () => {
    const google = createFakeAppsScript();
    const mangling: FetchLike = async (url, init) => {
      const res = await google.fetch(url, init);
      const body = (await res.json()) as { values?: string[] };
      if (body.values !== undefined) body.values = body.values.map((v) => (v === "007" ? "7" : v));
      return new Response(JSON.stringify(body));
    };
    const report = await setupSheet(client(mangling));
    expect(report.selfTestFailures).toEqual([{ sent: "007", received: "7" }]);
    expect(SELF_TEST_VALUES).toContain("007");
    expect(report.schemaVersion).toBe(SHEET_SCHEMA_VERSION);
  });
});
