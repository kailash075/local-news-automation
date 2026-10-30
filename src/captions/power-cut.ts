import { z } from "zod";
import { formatTamilDate, formatTamilTime } from "../graphics/tamil-date.ts";
import type { CardInput } from "../graphics/templates.ts";
import { assembleCaptionBody, composeCaption, hashtagsFor } from "./caption.ts";

/**
 * Deterministic draft for a planned power shutdown notice. The facts come from an editor or from a T1 notice;
 * the template never adds a fact that is not in `PowerCutFacts`.
 */

export type PowerCutFacts = {
  /** YYYY-MM-DD, the day of the shutdown. */
  date: string;
  /** HH:MM, 24 h, IST. */
  startTime: string;
  endTime: string;
  /** Main town or area for the headline, for example "பெருந்துறை". */
  placeTa: string;
  areasTa: readonly string[];
  /** Defaults to "பராமரிப்புப் பணிகள்" (maintenance work) only when the notice gives no reason. */
  reasonTa?: string;
  substationTa?: string;
  /** Who announced it, for example "மின் பகிர்மானக் கழகம், ஈரோடு". */
  sourceNameTa: string;
};

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const PowerCutFactsSchema = z
  .strictObject({
    date: z.iso.date(),
    startTime: HHMM,
    endTime: HHMM,
    placeTa: z.string().min(1).max(40),
    areasTa: z.array(z.string().min(1).max(40)).min(1).max(20).readonly(),
    reasonTa: z.string().min(1).max(80).exactOptional(),
    substationTa: z.string().min(1).max(60).exactOptional(),
    sourceNameTa: z.string().min(1).max(60),
  })
  .refine((f) => f.startTime < f.endTime, "the shutdown must end after it starts") satisfies z.ZodType<PowerCutFacts>;

export type PowerCutDraft = {
  headlineTa: string;
  /** Stored as `DraftRevision.captionTa`. */
  captionBody: string;
  /** Exactly what Instagram will receive (`composeCaption`). */
  fullCaption: string;
  altText: string;
  card: CardInput;
  hashtags: readonly string[];
  sourceCreditTa: string;
  /** Text the caption validator checks numbers against. */
  factText: string;
};

/** Noon IST on the given day, so the formatted date never slips across midnight. */
const dayAtNoonIst = (isoDate: string): Date => new Date(`${isoDate}T12:00:00+05:30`);

const joinWithinLimit = (items: readonly string[], limit: number): string => {
  let out = "";
  for (const item of items) {
    const next = out === "" ? item : `${out}, ${item}`;
    if (next.length > limit) return `${out} உள்ளிட்ட பகுதிகள்`;
    out = next;
  }
  return out;
};

export const draftPowerCut = (facts: PowerCutFacts, postingDate: Date): PowerCutDraft => {
  const fullDate = formatTamilDate(dayAtNoonIst(facts.date));
  const dayMonth = fullDate.split(" ").slice(0, 2).join(" ");
  const from = formatTamilTime(facts.startTime);
  const to = formatTamilTime(facts.endTime);
  const reason = facts.reasonTa ?? "பராமரிப்புப் பணிகள்";
  const sourceCreditTa = `தகவல்: ${facts.sourceNameTa}`;
  const hashtags = hashtagsFor("power_cut");

  const headlineTa = `${facts.placeTa} பகுதியில் ${dayMonth} மின் தடை`;
  const factLines = [
    `${fullDate} அன்று ${from} முதல் ${to} வரை மின் விநியோகம் நிறுத்தப்படும் என்று ${facts.sourceNameTa} அறிவித்துள்ளது.`,
    `காரணம்: ${reason}.`,
    ...(facts.substationTa === undefined ? [] : [`துணை மின் நிலையம்: ${facts.substationTa}.`]),
    `பாதிக்கப்படும் பகுதிகள்: ${facts.areasTa.join(", ")}.`,
  ];

  const captionBody = assembleCaptionBody({
    headlineTa,
    factLines,
    placeTa: facts.placeTa,
    dateTa: formatTamilDate(postingDate),
  });
  const fullCaption = composeCaption({ captionTa: captionBody, sourceCreditTa, hashtags });

  const card: CardInput = {
    template: "alert",
    categoryTa: "மின் தடை",
    placeTa: facts.placeTa,
    headlineTa: `${facts.placeTa} பகுதியில் ${dayMonth} ${from} முதல் ${to} வரை மின் தடை`,
    points: [`காரணம்: ${reason}`, `பகுதிகள்: ${joinWithinLimit(facts.areasTa, 70)}`],
    dateTa: fullDate,
    sourceCreditTa,
  };

  const altText = `மின் தடை அறிவிப்பு: ${facts.placeTa}, ${fullDate}, ${from} முதல் ${to} வரை. பகுதிகள்: ${facts.areasTa.join(", ")}. ${sourceCreditTa}.`;

  const factText = [JSON.stringify(facts), fullDate, from, to].join("\n");

  return { headlineTa, captionBody, fullCaption, altText, card, hashtags, sourceCreditTa, factText };
};
