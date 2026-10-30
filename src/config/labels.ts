import type { Topic } from "../domain/types.ts";
import { ERODE_KEY, ERODE_PLACES } from "./gazetteer.ts";

/** Tamil source credit for the caption line "தகவல்: …". Falls back to the registry name. */
export const CREDIT_TA: Readonly<Record<string, string>> = {
  "erode-district-administration": "ஈரோடு மாவட்ட நிர்வாகம்",
  "erode-city-corporation": "ஈரோடு மாநகராட்சி",
  "tn-dipr": "தமிழ்நாடு அரசு செய்தி மக்கள் தொடர்புத் துறை",
  "tnpdcl-erode-outages": "மின் பகிர்மானக் கழகம், ஈரோடு",
  "imd-rmc-chennai": "சென்னை மண்டல வானிலை ஆய்வு மையம்",
  pib: "பத்திரிகை தகவல் அலுவலகம்",
  "dinamalar-erode": "தினமலர்",
};

/** Category chip on the card. */
export const TOPIC_LABEL_TA: Readonly<Record<Topic, string>> = {
  power_cut: "மின் தடை",
  water_supply: "குடிநீர்",
  weather: "வானிலை",
  traffic: "போக்குவரத்து",
  jobs: "வேலைவாய்ப்பு",
  education: "கல்வி",
  health: "சுகாதாரம்",
  civic: "உள்ளாட்சி",
  accident: "விபத்து",
  crime: "காவல்துறை",
  politics: "அரசியல்",
  culture: "கலாச்சாரம்",
  business: "வணிகம்",
  sport: "விளையாட்டு",
  other: "செய்தி",
};

/** Topics shown with the urgent "alert" card. */
export const ALERT_TOPICS: ReadonlySet<Topic> = new Set(["power_cut", "water_supply", "weather", "traffic"]);

/**
 * Tamil display names for the card's place tag. The gazetteer's Tamil names are word-start stems for matching
 * (for example "அந்தியூர" also matches "அந்தியூரில்"), so the full names are listed here. Editors can correct a place in /caption.
 */
const PLACE_DISPLAY_TA: Readonly<Record<string, string>> = {
  [ERODE_KEY]: "ஈரோடு",
  Perundurai: "பெருந்துறை",
  Modakkurichi: "மொடக்குறிச்சி",
  Kodumudi: "கொடுமுடி",
  Gobichettipalayam: "கோபிசெட்டிபாளையம்",
  Sathyamangalam: "சத்தியமங்கலம்",
  Bhavani: "பவானி",
  Anthiyur: "அந்தியூர்",
  Thalavadi: "தாளவாடி",
  Nambiyur: "நம்பியூர்",
  Chennimalai: "சென்னிமலை",
  Bhavanisagar: "பவானிசாகர்",
  Kodiveri: "கொடிவேரி",
  Ammapettai: "அம்மாபேட்டை",
  Chithode: "சித்தோடு",
  Thindal: "திண்டல்",
  Surampatti: "சூரம்பட்டி",
  Veerappanchatram: "வீரப்பன்சத்திரம்",
  Kasipalayam: "காசிபாளையம்",
  Karungalpalayam: "கருங்கல்பாளையம்",
  Solar: "சோலார்",
  Lakkapuram: "லக்காபுரம்",
  Nanjanapuram: "நஞ்சனாபுரம்",
  Kavundapadi: "கவுந்தப்பாடி",
  Hasanur: "ஆசனூர்",
  Bargur: "பர்கூர்",
  Kanjikoil: "காஞ்சிக்கோவில்",
  Arachalur: "அரச்சலூர்",
  Sivagiri: "சிவகிரி",
  Nasiyanur: "நசியனூர்",
  Vellode: "வெள்ளோடு",
  "Punjai Puliampatti": "புஞ்சைபுளியம்பட்டி",
  Unjalur: "ஊஞ்சலூர்",
};

export const placeDisplayTa = (key: string | undefined): string =>
  (key === undefined ? undefined : PLACE_DISPLAY_TA[key]) ?? "ஈரோடு மாவட்டம்";

/** Every gazetteer place has a display name (checked by a test). */
export const placesWithoutDisplayName = (): readonly string[] => ERODE_PLACES.map((p) => p.key).filter((k) => PLACE_DISPLAY_TA[k] === undefined);
