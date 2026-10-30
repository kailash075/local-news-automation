import type { CardInput } from "./templates.ts";

/** Sample cards for the Phase 0 rendering check. The facts are invented placeholders, never for publication. */
export const SAMPLE_CARDS: readonly { name: string; input: CardInput }[] = [
  {
    name: "alert-power-cut",
    input: {
      template: "alert",
      categoryTa: "மின் தடை",
      placeTa: "பெருந்துறை",
      headlineTa: "பெருந்துறை பகுதியில் நாளை காலை 9 மணி முதல் மாலை 5 மணி வரை மின் தடை",
      points: ["பராமரிப்புப் பணிகள் காரணமாக மின் விநியோகம் நிறுத்தம்", "பாதிக்கப்படும் பகுதிகள்: சிப்காட், விஜயமங்கலம், திங்களூர்"],
      dateTa: "30 அக்டோபர் 2026",
      sourceCreditTa: "தகவல்: மாதிரி (சோதனைப் படம்)",
    },
  },
  {
    name: "news-water-supply",
    input: {
      template: "news",
      categoryTa: "மாநகராட்சி",
      placeTa: "ஈரோடு",
      headlineTa: "ஈரோடு மாநகராட்சி கிழக்கு மண்டலத்தில் இரண்டு நாட்கள் குடிநீர் விநியோக நேரம் மாற்றம்",
      points: ["கிழக்கு மண்டலத்தில் இரண்டு நாட்கள் மாற்றம்", "சூரம்பட்டி, வீரப்பன்சத்திரம், கருங்கல்பாளையம்", "மேலும் விவரங்களுக்கு மண்டல அலுவலகம்"],
      dateTa: "30 அக்டோபர் 2026",
      sourceCreditTa: "தகவல்: மாதிரி (சோதனைப் படம்)",
    },
  },
  {
    name: "correction",
    input: {
      template: "correction",
      categoryTa: "திருத்தம்",
      placeTa: "கோபிசெட்டிபாளையம்",
      headlineTa: "திருத்தம்: முகாம் நடைபெறும் தேதி 2 நவம்பர் (முன்பு 1 நவம்பர் என தவறாக குறிப்பிடப்பட்டது)",
      points: [],
      dateTa: "30 அக்டோபர் 2026",
      sourceCreditTa: "தகவல்: மாதிரி (சோதனைப் படம்)",
    },
  },
];
