import { err, ok, type Result } from "../lib/result.ts";
import type { GitHubLogin, RiskFlag, RiskTier, SensitiveCategory, Topic } from "../domain/types.ts";
import { normaliseForComparison } from "./normalise.ts";

/**
 * Rule-based risk tiers (docs/EDITORIAL_POLICY.md §5). The rule tier is a floor:
 * AI and editor flags can only raise it, an editor can lower the rule tier only with a recorded reason,
 * a disputed story is always R2, and a classifier failure is R2.
 */

const TIER_RANK: Readonly<Record<RiskTier, number>> = { R0_ROUTINE: 0, R1_STANDARD: 1, R2_SENSITIVE: 2 };

export const tierRank = (tier: RiskTier): number => TIER_RANK[tier];

export const maxTier = (...tiers: readonly RiskTier[]): RiskTier =>
  tiers.reduce<RiskTier>((acc, t) => (TIER_RANK[t] > TIER_RANK[acc] ? t : acc), "R0_ROUTINE");

/** Official schedules and notices are routine; crime and politics are sensitive by topic alone. */
export const baseTierForTopic = (topic: Topic): RiskTier => {
  switch (topic) {
    case "power_cut":
    case "water_supply":
    case "weather":
    case "traffic":
    case "jobs":
    case "education":
      return "R0_ROUTINE";
    case "civic":
    case "accident":
    case "health":
    case "culture":
    case "business":
    case "sport":
    case "other":
      return "R1_STANDARD";
    case "crime":
    case "politics":
      return "R2_SENSITIVE";
  }
};

type Keyword = string | RegExp;

type CategoryRule = { category: SensitiveCategory; keywords: readonly Keyword[] };

const word = (w: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "u");

/**
 * Keywords are matched against normaliseForComparison(text). Tamil strings are substrings; RegExps are used where a
 * plain substring would also hit an innocent word (சாதித்த "achieved" is not சாதி "caste"; பலித்தது "came true" is not பலி).
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: "crime",
    keywords: [
      "கைது", "கொலை", "திருட்டு", "திருடிய", "கொள்ளை", "மோசடி", "வழக்குப்பதிவு", "வழக்கு பதிவு", "நீதிமன்ற", "சிறையில்",
      "ஜாமீன்", "கஞ்சா", "போலீசில் புகார்", "குற்றவாளி", "கடத்தல்",
      word("arrest(?:ed|s)?"), word("murder(?:ed)?"), word("theft"), word("robbery"), word("fraud"), word("fir"), word("court"),
      word("jail(?:ed)?"), word("bail"), word("ganja"), word("police complaint"), word("cheating"), word("smuggling"), word("kidnap(?:ped|ping)?"),
    ],
  },
  {
    category: "death",
    keywords: [
      "உயிரிழ", /பலி(?!த)/u, "இறந்த", "சடலம", "சடலத்", "மரணம", "உயிர் இழந்த", "படுகாய",
      word("died"), word("dead"), word("death"), word("deaths"), word("killed"), word("body found"), word("deceased"), word("fatal"),
      word("critically injured"), word("seriously injured"),
    ],
  },
  {
    category: "suicide",
    keywords: ["தற்கொலை", "உயிரை மாய்த்", word("suicide"), word("self harm"), word("ended (?:his|her) life")],
  },
  {
    category: "sexual_offence",
    keywords: ["பாலியல்", "பலாத்கார", "போக்சோ", word("pocso"), word("rape(?:d)?"), word("sexual assault"), word("molest(?:ed|ation)?"), word("sexual harassment")],
  },
  {
    category: "minor",
    keywords: [
      "சிறுமி", "சிறுவன்", "சிறார்", "மைனர்", "குழந்தை திருமண", "குழந்தைத் தொழிலாளர்", "குழந்தை தொழிலாளர்",
      word("minor"), word("juvenile"), word("(?:girl|boy|child) aged"), word("child marriage"), word("child labour"),
    ],
  },
  {
    category: "communal",
    keywords: [
      /சாதி(?![தக])/u, "மதக் கலவர", "மத கலவர", "மத மோதல்", "மதவாத", "வகுப்புவாத", "ஆணவக் கொலை", "ஆணவ கொலை",
      word("caste"), word("communal"), word("honour killing"), word("religious clash"),
    ],
  },
  {
    category: "election",
    keywords: [
      "தேர்தல்", "வேட்பாளர்", "வாக்குப்பதிவு", "திமுக", "அதிமுக", "பாஜக", "காங்கிரஸ்", "தவெக", "நாம் தமிழர்", "எம்எல்ஏ", "எம் எல் ஏ",
      "அமைச்சர்", "ஆர்ப்பாட்டம்", "மறியல்", "போராட்டம்", "வேலைநிறுத்தம்",
      word("election"), word("candidate"), word("polling"), word("dmk"), word("aiadmk"), word("bjp"), word("congress"), word("tvk"), word("mla"), word("mp"),
      word("minister"), word("protest(?:s|ers)?"), word("strike"), word("agitation"),
    ],
  },
  {
    category: "allegation",
    keywords: ["குற்றச்சாட்டு", "குற்றம் சாட்ட", "புகார் அளித்", "புகாரின் பேரில்", "மீது புகார்", word("alleged(?:ly)?"), word("allegation(?:s)?"), word("accused of"), word("complaint against")],
  },
  {
    category: "health_claim",
    keywords: [
      "டெங்கு", "காலரா", "தொற்று பரவ", "உணவு விஷ", "கலப்பட", "உணவு பாதுகாப்பு", "பறவைக் காய்ச்சல்", "பறவை காய்ச்சல்", "நிபா",
      word("outbreak"), word("dengue"), word("cholera"), word("epidemic"), word("food poisoning"), word("adulterat(?:ed|ion)"), word("food safety"), word("nipah"), word("bird flu"),
    ],
  },
  {
    category: "disaster",
    keywords: [
      "வெள்ள அபாய", "வெள்ளப்பெருக்கு", "நிலச்சரிவு", "தீ விபத்", "வெடி விபத்", "மீட்புப் பணி", "மீட்பு பணி", "கூட்ட நெரிசலில்",
      word("earthquake"), word("landslide"), word("flood (?:alert|warning)"), word("flooding"), word("fire broke out"), word("blaze"), word("explosion"),
      word("evacuat(?:ed|ion)"), word("stampede"),
    ],
  },
  {
    category: "graphic",
    keywords: ["ரத்த வெள்ள", "சிதைந்த", "கருகி", "தலை துண்டி", "அழுகிய நிலையில்", word("beheaded"), word("mutilated"), word("gruesome"), word("charred"), word("decomposed")],
  },
];

const describe = (k: Keyword): string => (typeof k === "string" ? k : k.source);

const matches = (text: string, k: Keyword): boolean => (typeof k === "string" ? text.includes(k) : k.test(text));

/** One flag per matched category, origin "rule". */
export const ruleFlags = (text: string): readonly RiskFlag[] => {
  const t = normaliseForComparison(text);
  const flags: RiskFlag[] = [];
  for (const rule of CATEGORY_RULES) {
    const hits = rule.keywords.filter((k) => matches(t, k)).map(describe);
    if (hits.length > 0) {
      flags.push({ category: rule.category, origin: "rule", detail: `keyword: ${hits.slice(0, 3).join(", ")}`.slice(0, 300) });
    }
  }
  return flags;
};

export type RuleRiskAssessment = {
  tier: RiskTier;
  flags: readonly RiskFlag[];
  /** True when the classifier threw; the tier is then R2. */
  classifierFailed: boolean;
};

/** Never throws: a classifier failure yields R2. */
export const assessRuleRisk = (
  text: string,
  topic: Topic,
  classify: (text: string) => readonly RiskFlag[] = ruleFlags,
): RuleRiskAssessment => {
  try {
    const flags = classify(text);
    return { tier: maxTier(baseTierForTopic(topic), flags.length > 0 ? "R2_SENSITIVE" : "R0_ROUTINE"), flags, classifierFailed: false };
  } catch {
    return { tier: "R2_SENSITIVE", flags: [], classifierFailed: true };
  }
};

export type TierOverride = {
  tier: RiskTier;
  editorLogin: GitHubLogin;
  reason: string;
};

export type LowerTierError = "reason_required" | "not_lower";

/** An editor may lower the rule tier only with a recorded reason (for example a keyword false positive). */
export const requestLowerTier = (
  current: RiskTier,
  target: RiskTier,
  editorLogin: GitHubLogin,
  reason: string,
): Result<TierOverride, LowerTierError> => {
  if (reason.trim().length < 10) return err("reason_required");
  if (TIER_RANK[target] >= TIER_RANK[current]) return err("not_lower");
  return ok({ tier: target, editorLogin, reason: reason.trim() });
};

export type RiskInputs = {
  topic: Topic;
  /** All flags on the story: rule, AI and editor origins. */
  flags: readonly RiskFlag[];
  disputed: boolean;
  classifierFailed?: boolean;
  override?: TierOverride;
};

const tierOfFlags = (flags: readonly RiskFlag[]): RiskTier => (flags.length > 0 ? "R2_SENSITIVE" : "R0_ROUTINE");

/**
 * Final tier = max(rule tier, AI tier, editor-flag tier).
 * The editor override replaces only the rule side, so AI and editor flags still raise the result.
 */
export const finalTier = (inputs: RiskInputs): RiskTier => {
  if (inputs.disputed) return "R2_SENSITIVE";
  const ruleSide =
    inputs.classifierFailed === true
      ? "R2_SENSITIVE"
      : maxTier(baseTierForTopic(inputs.topic), tierOfFlags(inputs.flags.filter((f) => f.origin === "rule")));
  const effectiveRule =
    inputs.override !== undefined && TIER_RANK[inputs.override.tier] < TIER_RANK[ruleSide] ? inputs.override.tier : ruleSide;
  const raised = tierOfFlags(inputs.flags.filter((f) => f.origin === "ai" || f.origin === "editor"));
  return maxTier(effectiveRule, raised);
};
