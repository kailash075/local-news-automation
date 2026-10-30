import { assertNever } from "../lib/result.ts";
import type { RiskTier, VerificationEvidence, VerificationLevel } from "./types.ts";

/** Ordering of levels: a higher rank is stronger evidence. */
const RANK: Readonly<Record<VerificationLevel, number>> = {
  V0_UNVERIFIED: 0,
  V1_CORROBORATED: 1,
  V2_OFFICIAL: 2,
  V3_EDITOR_ATTESTED: 3,
};

/**
 * The verification level is derived from evidence rows only. There is no AI evidence kind,
 * so model output can never raise this level.
 */
export const deriveVerificationLevel = (evidence: readonly VerificationEvidence[]): VerificationLevel => {
  let best: VerificationLevel = "V0_UNVERIFIED";
  for (const e of evidence) {
    const level = levelOf(e);
    if (RANK[level] > RANK[best]) best = level;
  }
  return best;
};

const levelOf = (e: VerificationEvidence): VerificationLevel => {
  switch (e.kind) {
    case "editor_attestation":
      return "V3_EDITOR_ATTESTED";
    case "official_source":
      return "V2_OFFICIAL";
    case "independent_corroboration":
      return "V1_CORROBORATED";
    default:
      return assertNever(e);
  }
};

/** Minimum level to publish, from the editorial policy §4. Disputed stories need an editor's attestation. */
export const minimumFor = (riskTier: RiskTier, disputed: boolean): VerificationLevel => {
  if (disputed) return "V3_EDITOR_ATTESTED";
  switch (riskTier) {
    case "R0_ROUTINE":
    case "R1_STANDARD":
      return "V1_CORROBORATED";
    case "R2_SENSITIVE":
      return "V2_OFFICIAL";
    default:
      return assertNever(riskTier);
  }
};

export const meetsMinimum = (level: VerificationLevel, riskTier: RiskTier, disputed: boolean): boolean =>
  RANK[level] >= RANK[minimumFor(riskTier, disputed)];
