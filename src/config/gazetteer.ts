/**
 * Place names for the Erode relevance filter.
 *
 * DRAFT: verify every entry against the Erode district administration website (erode.nic.in) before Phase 1 sign-off.
 *
 * Matching rules (see src/pipeline/relevance.ts):
 * - Tamil entries are stems matched at the start of a word, so inflected forms match too
 *   (ஈரோட matches ஈரோடு and ஈரோட்டில்; அந்தியூர matches அந்தியூர் and அந்தியூரில்).
 * - English entries are case-sensitive whole words. "Erode" itself needs place context, because "erode" is also a verb.
 * - `weakTa` / `weakEn` are ambiguous names (shared with places in other districts, or ordinary words).
 *   They tag a story but never make it relevant on their own.
 */

export type PlaceKind = "city" | "taluk" | "town" | "area" | "landmark";

export type Place = {
  /** Canonical English name, used as the place tag. */
  key: string;
  kind: PlaceKind;
  ta: readonly string[];
  en: readonly string[];
  weakTa?: readonly string[];
  weakEn?: readonly string[];
};

export type NeighbourPlace = Place & { district: string };

/** English "Erode" counts only with place context; handled specially by the relevance filter. */
export const ERODE_KEY = "Erode";

export const ERODE_PLACES: readonly Place[] = [
  { key: ERODE_KEY, kind: "city", ta: ["ஈரோட"], en: [] },
  // Taluks (docs/EDITORIAL_POLICY.md §1)
  { key: "Perundurai", kind: "taluk", ta: ["பெருந்துறை"], en: ["Perundurai"] },
  { key: "Modakkurichi", kind: "taluk", ta: ["மொடக்குறிச்சி"], en: ["Modakkurichi", "Modakurichi"] },
  { key: "Kodumudi", kind: "taluk", ta: ["கொடுமுடி"], en: ["Kodumudi"] },
  {
    key: "Gobichettipalayam",
    kind: "taluk",
    ta: ["கோபிசெட்டிபாளைய", "கோபி செட்டிபாளைய"],
    en: ["Gobichettipalayam"],
    weakTa: ["கோபி"],
    weakEn: ["Gobi"],
  },
  {
    key: "Sathyamangalam",
    kind: "taluk",
    ta: ["சத்தியமங்கல"],
    en: ["Sathyamangalam", "Sathiyamangalam", "Satyamangalam"],
    weakEn: ["Sathy"],
  },
  { key: "Bhavani", kind: "taluk", ta: ["பவானி"], en: ["Bhavani"] },
  { key: "Anthiyur", kind: "taluk", ta: ["அந்தியூர"], en: ["Anthiyur"] },
  { key: "Thalavadi", kind: "taluk", ta: ["தாளவாடி"], en: ["Thalavadi", "Talavadi"] },
  { key: "Nambiyur", kind: "taluk", ta: ["நம்பியூர"], en: ["Nambiyur"] },
  // Towns, areas and landmarks
  { key: "Chennimalai", kind: "town", ta: ["சென்னிமலை"], en: ["Chennimalai"] },
  { key: "Bhavanisagar", kind: "town", ta: ["பவானிசாகர"], en: ["Bhavanisagar", "Bhavani Sagar"] },
  { key: "Kodiveri", kind: "landmark", ta: ["கொடிவேரி"], en: ["Kodiveri"] },
  { key: "Ammapettai", kind: "town", ta: [], en: [], weakTa: ["அம்மாபேட்டை"], weakEn: ["Ammapettai"] },
  { key: "Chithode", kind: "town", ta: ["சித்தோட"], en: ["Chithode", "Chithodu"] },
  { key: "Thindal", kind: "area", ta: ["திண்டல"], en: ["Thindal"] },
  { key: "Surampatti", kind: "area", ta: ["சூரம்பட்டி"], en: ["Surampatti"] },
  {
    key: "Veerappanchatram",
    kind: "area",
    ta: ["வீரப்பன்சத்திர", "வீரப்பன் சத்திர"],
    en: ["Veerappanchatram", "Veerappan Chatram"],
  },
  { key: "Kasipalayam", kind: "area", ta: [], en: [], weakTa: ["காசிபாளைய"], weakEn: ["Kasipalayam"] },
  { key: "Karungalpalayam", kind: "area", ta: ["கருங்கல்பாளைய"], en: ["Karungalpalayam"] },
  { key: "Solar", kind: "area", ta: [], en: [], weakTa: ["சோலார"], weakEn: ["Solar"] },
  { key: "Lakkapuram", kind: "area", ta: ["லக்காபுர"], en: ["Lakkapuram"] },
  { key: "Nanjanapuram", kind: "area", ta: ["நஞ்சனாபுர"], en: ["Nanjanapuram"] },
  { key: "Kavundapadi", kind: "town", ta: ["கவுந்தப்பாடி"], en: ["Kavundapadi", "Kavindapadi"] },
  { key: "Hasanur", kind: "town", ta: ["ஆசனூர", "ஹாசனூர", "ஹசனூர"], en: ["Hasanur", "Asanur"] },
  { key: "Bargur", kind: "town", ta: [], en: [], weakTa: ["பர்கூர"], weakEn: ["Bargur"] },
  { key: "Kanjikoil", kind: "town", ta: ["காஞ்சிக்கோவில", "காஞ்சிகோவில"], en: ["Kanjikoil", "Kanjikovil"] },
  { key: "Arachalur", kind: "town", ta: ["அரச்சலூர"], en: ["Arachalur"] },
  { key: "Sivagiri", kind: "town", ta: [], en: [], weakTa: ["சிவகிரி"], weakEn: ["Sivagiri"] },
  { key: "Nasiyanur", kind: "town", ta: ["நசியனூர"], en: ["Nasiyanur"] },
  // "வெள்ளோட" alone would also match வெள்ளோட்டம் ("trial run"), so only full forms.
  { key: "Vellode", kind: "town", ta: ["வெள்ளோடு", "வெள்ளோட்டில"], en: ["Vellode"] },
  {
    key: "Punjai Puliampatti",
    kind: "town",
    ta: ["புஞ்சைபுளியம்பட்டி", "புஞ்சை புளியம்பட்டி"],
    en: ["Punjai Puliampatti", "Puliampatti", "Puliyampatti"],
    weakTa: ["புளியம்பட்டி"],
  },
  { key: "Unjalur", kind: "town", ta: ["ஊஞ்சலூர"], en: ["Unjalur"] },
];

/**
 * Places outside Erode district that often appear next to it (the Coimbatore 360 lesson: "close" is not "ours").
 * Pallipalayam and Kumarapalayam sit across the Cauvery from Bhavani but are in Namakkal district.
 */
export const NEIGHBOUR_PLACES: readonly NeighbourPlace[] = [
  { key: "Tiruppur", district: "Tiruppur", kind: "city", ta: ["திருப்பூர"], en: ["Tiruppur", "Tirupur"] },
  { key: "Avinashi", district: "Tiruppur", kind: "town", ta: ["அவிநாசி", "அவினாசி"], en: ["Avinashi", "Avanashi"] },
  { key: "Kangeyam", district: "Tiruppur", kind: "town", ta: ["காங்கேய"], en: ["Kangeyam", "Kangayam"] },
  { key: "Dharapuram", district: "Tiruppur", kind: "town", ta: ["தாராபுர"], en: ["Dharapuram"] },
  { key: "Palladam", district: "Tiruppur", kind: "town", ta: ["பல்லட"], en: ["Palladam"] },
  { key: "Udumalaipettai", district: "Tiruppur", kind: "town", ta: ["உடுமலை"], en: ["Udumalaipettai", "Udumalpet"] },
  { key: "Vellakovil", district: "Tiruppur", kind: "town", ta: ["வெள்ளகோவில"], en: ["Vellakovil", "Vellakoil"] },
  { key: "Coimbatore", district: "Coimbatore", kind: "city", ta: ["கோயம்புத்தூர", "கோவை"], en: ["Coimbatore", "Kovai"] },
  { key: "Mettupalayam", district: "Coimbatore", kind: "town", ta: ["மேட்டுப்பாளைய"], en: ["Mettupalayam"] },
  { key: "Pollachi", district: "Coimbatore", kind: "town", ta: ["பொள்ளாச்சி"], en: ["Pollachi"] },
  { key: "Salem", district: "Salem", kind: "city", ta: ["சேலம்", "சேலத்"], en: ["Salem"] },
  { key: "Mettur", district: "Salem", kind: "town", ta: ["மேட்டூர"], en: ["Mettur"] },
  { key: "Namakkal", district: "Namakkal", kind: "city", ta: ["நாமக்கல"], en: ["Namakkal"] },
  { key: "Pallipalayam", district: "Namakkal", kind: "town", ta: ["பள்ளிபாளைய"], en: ["Pallipalayam"] },
  { key: "Kumarapalayam", district: "Namakkal", kind: "town", ta: ["குமாரபாளைய"], en: ["Kumarapalayam", "Komarapalayam"] },
  { key: "Tiruchengode", district: "Namakkal", kind: "town", ta: ["திருச்செங்கோட"], en: ["Tiruchengode"] },
  { key: "Rasipuram", district: "Namakkal", kind: "town", ta: ["ராசிபுர"], en: ["Rasipuram"] },
  { key: "Karur", district: "Karur", kind: "city", ta: ["கரூர"], en: ["Karur"] },
  { key: "Nilgiris", district: "Nilgiris", kind: "area", ta: ["நீலகிரி"], en: ["Nilgiris"] },
  {
    key: "Ooty",
    district: "Nilgiris",
    kind: "town",
    ta: ["உதகை", "உதகமண்டல"],
    en: ["Ooty", "Udhagamandalam"],
    // ஊட்டி is also a verb form ("having fed").
    weakTa: ["ஊட்டி"],
  },
  { key: "Coonoor", district: "Nilgiris", kind: "town", ta: ["குன்னூர"], en: ["Coonoor"] },
  { key: "Chamarajanagar", district: "Chamarajanagar (Karnataka)", kind: "town", ta: ["சாமராஜநகர"], en: ["Chamarajanagar", "Chamarajanagara"] },
  { key: "Kollegal", district: "Chamarajanagar (Karnataka)", kind: "town", ta: ["கொள்ளேகால"], en: ["Kollegal"] },
  { key: "Dindigul", district: "Dindigul", kind: "city", ta: ["திண்டுக்கல"], en: ["Dindigul"] },
  { key: "Palakkad", district: "Palakkad (Kerala)", kind: "city", ta: ["பாலக்காடு", "பாலக்காட்ட"], en: ["Palakkad"] },
  { key: "Chennai", district: "Chennai", kind: "city", ta: ["சென்னை"], en: ["Chennai"] },
  { key: "Madurai", district: "Madurai", kind: "city", ta: ["மதுரை"], en: ["Madurai"] },
  { key: "Tiruchirappalli", district: "Tiruchirappalli", kind: "city", ta: ["திருச்சி"], en: ["Tiruchirappalli", "Trichy"] },
  { key: "Bengaluru", district: "Bengaluru (Karnataka)", kind: "city", ta: ["பெங்களூர"], en: ["Bengaluru", "Bangalore"] },
];
