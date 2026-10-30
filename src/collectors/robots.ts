import { BOT_NAME } from "./http.ts";

/**
 * Minimal robots.txt support following RFC 9309: user-agent groups, Allow/Disallow with `*` and `$`,
 * longest match wins, Allow wins a tie. Unknown lines (Sitemap, Crawl-delay, ...) are ignored.
 */

export type RobotsRule = { allow: boolean; pattern: string };

export type RobotsGroup = { agents: readonly string[]; rules: readonly RobotsRule[] };

export type RobotsTxt = { groups: readonly RobotsGroup[] };

export const parseRobots = (text: string): RobotsTxt => {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | undefined;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (current === undefined) continue;
      // An empty Disallow means "allow everything" and adds no rule.
      if (value === "") continue;
      current.rules.push({ allow: field === "allow", pattern: value });
      continue;
    }
    // Other fields end a run of User-agent lines but are otherwise ignored.
    lastWasAgent = false;
  }
  return { groups };
};

const patternToRegExp = (pattern: string): RegExp => {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
};

/** Rules that apply to `agent`: the groups naming its product token, otherwise the `*` groups, otherwise none. */
const rulesFor = (robots: RobotsTxt, agent: string): readonly RobotsRule[] => {
  const token = agent.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  const chosen = specific.length > 0 ? specific : robots.groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
};

/** `path` is the URL path plus query, for example `/news/erode?page=2`. */
export const isAllowed = (robots: RobotsTxt | string, path: string, agent: string = BOT_NAME): boolean => {
  const parsed = typeof robots === "string" ? parseRobots(robots) : robots;
  if (path === "/robots.txt") return true;
  let best: { length: number; allow: boolean } | undefined;
  for (const rule of rulesFor(parsed, agent)) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    const length = rule.pattern.length;
    if (best === undefined || length > best.length || (length === best.length && rule.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best?.allow ?? true;
};
