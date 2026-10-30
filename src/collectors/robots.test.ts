import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "./robots.ts";

const DINAMALAR_LIKE = `
User-agent: GPTBot
Disallow: /

User-agent: CCBot
User-agent: Google-Extended
Disallow: /

User-agent: *
Disallow: /admin/
Disallow: /*?print=
Allow: /admin/public$
Sitemap: https://example.com/sitemap.xml
`;

describe("robots.txt", () => {
  it("groups consecutive User-agent lines", () => {
    const r = parseRobots(DINAMALAR_LIKE);
    expect(r.groups.map((g) => g.agents)).toEqual([["gptbot"], ["ccbot", "google-extended"], ["*"]]);
  });

  it("falls back to the * group when our bot is not named", () => {
    expect(isAllowed(DINAMALAR_LIKE, "/news/tamil-nadu-district-news-erode")).toBe(true);
    expect(isAllowed(DINAMALAR_LIKE, "/admin/settings")).toBe(false);
    expect(isAllowed(DINAMALAR_LIKE, "/news/1?print=1")).toBe(false);
  });

  it("applies the longest match, with $ anchoring", () => {
    expect(isAllowed(DINAMALAR_LIKE, "/admin/public")).toBe(true);
    expect(isAllowed(DINAMALAR_LIKE, "/admin/public/x")).toBe(false);
  });

  it("uses a group naming our bot instead of *", () => {
    const txt = "User-agent: *\nDisallow:\n\nUser-agent: ErodeGlitzBot\nDisallow: /news/\n";
    expect(isAllowed(txt, "/news/1")).toBe(false);
    expect(isAllowed(txt, "/other")).toBe(true);
  });

  it("an Allow wins a tie with a Disallow of the same length", () => {
    expect(isAllowed("User-agent: *\nDisallow: /a\nAllow: /a\n", "/a")).toBe(true);
  });

  it("an empty file or empty Disallow allows everything; robots.txt itself is always allowed", () => {
    expect(isAllowed("", "/anything")).toBe(true);
    expect(isAllowed("User-agent: *\nDisallow:\n", "/x")).toBe(true);
    expect(isAllowed("User-agent: *\nDisallow: /\n", "/robots.txt")).toBe(true);
  });
});
