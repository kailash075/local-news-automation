import type { Topic } from "../domain/types.ts";
import { normaliseForComparison } from "./normalise.ts";

/**
 * Rule-based topic detection. Topic sets queue priority only; risk is assessed separately (src/pipeline/risk.ts).
 * Text is matched after normaliseForComparison: lower-case Latin, no punctuation, Tamil digits as ASCII.
 * Tamil keywords are substrings (Tamil inflects by suffix); English keywords are whole words.
 */

type TopicRule = {
  topic: Topic;
  ta: readonly string[];
  en: readonly string[];
};

const RULES: readonly TopicRule[] = [
  {
    topic: "power_cut",
    ta: ["மின்தடை", "மின் தடை", "மின்நிறுத்தம்", "மின் நிறுத்தம்", "மின் விநியோகம் இருக்காது", "மின்விநியோகம் இருக்காது", "மின் வினியோகம் இருக்காது", "மின்சாரம் இருக்காது"],
    en: ["power shutdown", "power cut", "power cuts", "power outage", "power supply will be suspended", "power interruption"],
  },
  {
    topic: "water_supply",
    ta: ["குடிநீர்", "குடி நீர்"],
    en: ["drinking water", "water supply"],
  },
  {
    topic: "weather",
    ta: ["மழை", "வானிலை", "புயல்", "வெப்ப அலை", "பனிமூட்ட"],
    en: ["rain", "rainfall", "heavy rain", "weather", "imd", "cyclone", "orange alert", "yellow alert", "red alert", "heatwave", "heat wave"],
  },
  {
    topic: "traffic",
    ta: ["போக்குவரத்து மாற்ற", "போக்குவரத்து நெரிசல்", "சாலை மூட", "போக்குவரத்துக்கு தடை", "சிறப்பு ரயில்", "ரயில் சேவை", "பேருந்து சேவை", "சிறப்பு பேருந்து", "ரயில்கள் ரத்து"],
    en: ["traffic diversion", "traffic diverted", "road closure", "road closed", "special train", "train service", "trains cancelled", "bus service", "special buses"],
  },
  {
    topic: "accident",
    ta: ["விபத்து", "மோதி", "கவிழ்ந்து"],
    en: ["accident", "collision", "collided", "overturned", "mishap"],
  },
  {
    topic: "crime",
    ta: ["கைது", "போலீசார்", "கொலை", "திருட்டு", "கொள்ளை", "மோசடி", "வழக்குப்பதிவு", "வழக்கு பதிவு", "கஞ்சா", "கடத்தல்"],
    en: ["arrested", "arrest", "murder", "theft", "robbery", "fraud", "police", "fir", "ganja", "smuggling", "cheating"],
  },
  {
    topic: "civic",
    ta: ["மாநகராட்சி", "நகராட்சி", "பேரூராட்சி", "ஊராட்சி", "கலெக்டர்", "ஆட்சியர்", "குறைதீர்", "கழிவுநீர்", "தெருவிளக்கு", "சாலைப் பணி", "சாலை பணி"],
    en: ["corporation", "municipality", "collector", "grievance", "sewage", "streetlight", "civic"],
  },
  {
    topic: "jobs",
    ta: ["வேலைவாய்ப்பு", "வேலை வாய்ப்பு", "காலிப்பணியிட", "ஆட்சேர்ப்பு"],
    en: ["job fair", "recruitment", "vacancy", "vacancies", "employment camp"],
  },
  {
    topic: "education",
    ta: ["பள்ளி", "கல்லூரி", "தேர்வு", "மாணவர்", "மாணவி", "மாணவர் சேர்க்கை"],
    en: ["school", "college", "exam", "examination", "students", "admission", "university"],
  },
  {
    topic: "health",
    ta: ["மருத்துவமனை", "மருத்துவ முகாம்", "சுகாதார", "காய்ச்சல்", "டெங்கு", "தடுப்பூசி"],
    en: ["hospital", "medical camp", "health", "dengue", "fever", "vaccination"],
  },
  {
    topic: "politics",
    ta: ["தேர்தல்", "எம்எல்ஏ", "எம் எல் ஏ", "அமைச்சர்", "திமுக", "அதிமுக", "பாஜக", "காங்கிரஸ்", "ஆர்ப்பாட்டம்", "மறியல்"],
    en: ["election", "mla", "minister", "dmk", "aiadmk", "bjp", "congress", "protest"],
  },
  {
    topic: "business",
    ta: ["மஞ்சள்", "ஜவுளி", "சந்தை", "ஏலம்", "விலை"],
    en: ["turmeric", "textile", "market", "auction", "price", "prices"],
  },
  {
    topic: "culture",
    ta: ["திருவிழா", "கோவில்", "கோயில்", "கும்பாபிஷேக", "தேரோட்ட"],
    en: ["festival", "temple", "car festival"],
  },
  {
    topic: "sport",
    ta: ["விளையாட்டு", "கிரிக்கெட்", "கபடி", "போட்டியில்"],
    en: ["sports", "tournament", "cricket", "kabaddi", "football", "athletics"],
  },
];

/** Priority weights: the Coimbatore 360 insight that power cuts lead, then other service notices, then incidents. */
export const TOPIC_WEIGHTS: Readonly<Record<Topic, number>> = {
  power_cut: 100,
  water_supply: 92,
  weather: 85,
  traffic: 78,
  accident: 70,
  crime: 64,
  civic: 58,
  jobs: 52,
  education: 46,
  health: 40,
  politics: 34,
  business: 30,
  culture: 28,
  sport: 24,
  other: 20,
};

/** Half-life of priority, in hours. */
const PRIORITY_HALF_LIFE_HOURS = 24;

const englishPatterns = new Map<string, RegExp>();
const englishPattern = (keyword: string): RegExp => {
  let re = englishPatterns.get(keyword);
  if (re === undefined) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
    englishPatterns.set(keyword, re);
  }
  return re;
};

export type TopicMatch = { topic: Topic; keyword: string };

export const topicMatches = (text: string): readonly TopicMatch[] => {
  const t = normaliseForComparison(text);
  const out: TopicMatch[] = [];
  for (const rule of RULES) {
    for (const keyword of rule.ta) if (t.includes(keyword)) out.push({ topic: rule.topic, keyword });
    for (const keyword of rule.en) if (englishPattern(keyword).test(t)) out.push({ topic: rule.topic, keyword });
  }
  return out;
};

/** The matched topic with the highest weight, or "other". */
export const detectTopic = (text: string): Topic => {
  let best: Topic = "other";
  for (const { topic } of topicMatches(text)) {
    if (TOPIC_WEIGHTS[topic] > TOPIC_WEIGHTS[best]) best = topic;
  }
  return best;
};

/** Topic weight decayed by age (half-life 24 h). Unknown publication time counts as fresh. */
export const priorityFor = (topic: Topic, publishedAt: Date | undefined, now: Date): number => {
  const ageHours = publishedAt === undefined ? 0 : Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
  const value = TOPIC_WEIGHTS[topic] * 0.5 ** (ageHours / PRIORITY_HALF_LIFE_HOURS);
  return Math.round(value * 1000) / 1000;
};
