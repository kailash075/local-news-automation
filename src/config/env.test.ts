import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.ts";

/** What a workflow step's env looks like when none of the repository variables has been created yet. */
const UNSET_GITHUB_VARIABLES = {
  APPROVAL_TTL_HOURS: "",
  COLLECTING_ENABLED: "",
  DRY_RUN: "",
  EDITOR_GITHUB_LOGINS: "",
  IG_GRAPH_VERSION: "",
  MAX_POSTS_PER_DAY: "",
  MAX_STORY_AGE_HOURS: "",
  MIN_MINUTES_BETWEEN_POSTS: "",
  OWNER_GITHUB_LOGIN: "",
  POSTING_WINDOW_IST: "",
  PUBLISHING_ENABLED: "",
  PUBLISH_ON_APPROVAL: "",
};

describe("loadEnv", () => {
  it("treats unset GitHub variables (empty strings) like missing ones", () => {
    expect(loadEnv(UNSET_GITHUB_VARIABLES)).toEqual(loadEnv({}));
  });

  it("keeps defaults and fails closed when the variables are empty", () => {
    const env = loadEnv(UNSET_GITHUB_VARIABLES);
    expect(env.IG_GRAPH_VERSION).toBe("v26.0");
    expect(env.MAX_POSTS_PER_DAY).toBe(6);
    expect(env.MIN_MINUTES_BETWEEN_POSTS).toBe(30);
    expect(env.POSTING_WINDOW_IST).toEqual({ startMinute: 8 * 60, endMinute: 21 * 60 });
    expect(env.PUBLISHING_ENABLED).toBe(false);
    expect(env.COLLECTING_ENABLED).toBe(false);
    expect(env.DRY_RUN).toBe(true);
    expect(env.EDITOR_GITHUB_LOGINS).toEqual([]);
    expect(env.OWNER_GITHUB_LOGIN).toBeUndefined();
  });

  it("treats blank values as not set", () => {
    expect(loadEnv({ MAX_POSTS_PER_DAY: "  ", SHEET_BRIDGE_KEY: " " })).toEqual(loadEnv({}));
  });

  it("still rejects a value that is set but wrong", () => {
    expect(() => loadEnv({ IG_GRAPH_VERSION: "26" })).toThrow();
    expect(() => loadEnv({ MAX_POSTS_PER_DAY: "100" })).toThrow();
  });
});
