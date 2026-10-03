import type { TechnicalSourceType } from "./types";
import { extractReferenceSpecClaims } from "./spec-guard";
import { draftBlob, normalizeForCompare } from "./text";
import { issue, type GuardIssue } from "./guard-issue";

export type TechnicalClaimPayload = {
  claim?: string | null;
  valueText?: string | null;
  sourceType?: string | null;
  vehicleSpecific?: boolean | null;
};

const SOURCE_TYPES = new Set<TechnicalSourceType>([
  "VERIFIED_OEM",
  "VERIFIED_TECHNICAL",
  "GENERAL_PRINCIPLE",
  "MODEL_KNOWLEDGE",
  "UNKNOWN",
]);

function normalizeSourceType(raw: string | null | undefined): TechnicalSourceType | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (SOURCE_TYPES.has(key as TechnicalSourceType)) {
    return key as TechnicalSourceType;
  }
  return null;
}

function looksVehicleSpecificClaim(text: string): boolean {
  const n = normalizeForCompare(text);
  return (
    /(za ovo vozilo|na ovom vozilu|oem|tvornick|tvorničk|specifikac|pin\s*\d|pinout|moment|torque)/.test(
      n,
    ) || extractReferenceSpecClaims(text).length > 0
  );
}

/**
 * Enforce sourceType honesty for technical claims/specs.
 * Vehicle-specific values cannot be GENERAL_PRINCIPLE.
 * MODEL_KNOWLEDGE / UNKNOWN cannot be treated as verified specs.
 * VERIFIED_* is never accepted. There is no external spec source.
 */
export function findTechnicalSourceTypeIssue(
  draft: {
    actionType?: string;
    content?: string;
    rationale?: string;
    expectedResultHint?: string | null;
    confirmedFault?: string | null;
    testGuide?: string | null;
    technicalClaims?: TechnicalClaimPayload[] | null;
  },
): string | null {
  const text = draftBlob(draft);
  const claims = Array.isArray(draft.technicalClaims)
    ? draft.technicalClaims
    : [];

  for (const claim of claims) {
    const sourceType = normalizeSourceType(claim.sourceType);
    const claimText = `${claim.claim ?? ""} ${claim.valueText ?? ""}`.trim();
    if (!claimText && !claim.sourceType) continue;
    if (!claimText) {
      return (
        "TECH SOURCE GUARD: svaka tehnička tvrdnja/spec mora imati sourceType " +
        "(VERIFIED_OEM | VERIFIED_TECHNICAL | GENERAL_PRINCIPLE | MODEL_KNOWLEDGE | UNKNOWN)."
      );
    }

    if (!sourceType) {
      return (
        "TECH SOURCE GUARD: svaka tehnička tvrdnja/spec mora imati sourceType " +
        "(VERIFIED_OEM | VERIFIED_TECHNICAL | GENERAL_PRINCIPLE | MODEL_KNOWLEDGE | UNKNOWN)."
      );
    }

    const vehicleSpecific =
      claim.vehicleSpecific === true || looksVehicleSpecificClaim(claimText);

    if (vehicleSpecific && sourceType === "GENERAL_PRINCIPLE") {
      return (
        "TECH SOURCE GUARD: vehicle-specific vrijednost ne smije biti označena kao GENERAL_PRINCIPLE. " +
        "Koristi UNKNOWN ili MODEL_KNOWLEDGE. VERIFIED_* nije dozvoljen."
      );
    }

    if (sourceType === "VERIFIED_OEM" || sourceType === "VERIFIED_TECHNICAL") {
      return (
        "TECH SOURCE GUARD: VERIFIED_OEM/VERIFIED_TECHNICAL nije dozvoljen. " +
        "Koristi UNKNOWN ili MODEL_KNOWLEDGE."
      );
    }

    if (
      (sourceType === "MODEL_KNOWLEDGE" || sourceType === "UNKNOWN") &&
      /(kao verified|kao verificiran|verified spec|verificirani spec|oem verified)/i.test(
        claimText,
      )
    ) {
      return (
        "TECH SOURCE GUARD: MODEL_KNOWLEDGE/UNKNOWN ne smije se koristiti kao verificirani spec."
      );
    }
  }

  const implicitClaims = extractReferenceSpecClaims(text);
  if (implicitClaims.length > 0) {
    const hasHonestUnknown = claims.some((c) => {
      const st = normalizeSourceType(c.sourceType);
      return st === "UNKNOWN" || st === "MODEL_KNOWLEDGE";
    });
    const n = normalizeForCompare(text);
    const presentsAsGeneral =
      /(opci princip|opći princip|general principle|uvijek je|uvijek iznosi)/.test(
        n,
      ) && looksVehicleSpecificClaim(text);

    if (presentsAsGeneral) {
      return (
        "TECH SOURCE GUARD: vehicle-specific spec je predstavljen kao GENERAL_PRINCIPLE — zabranjeno."
      );
    }

    if (
      !hasHonestUnknown &&
      /(mora biti|trebalo bi|ocekivan|očekivan|oem|za ovo vozilo|na ovom vozilu)/i.test(
        text,
      )
    ) {
      return (
        "TECH SOURCE GUARD: tehnička tvrdnja/spec mora imati sourceType UNKNOWN ili MODEL_KNOWLEDGE. " +
        "Ne tvrdi vehicle-specific vrijednost kao verified."
      );
    }
  }

  return null;
}

/**
 * Obvious live SRS connector/module work, HV / orange-cable / inverter work,
 * or pyrotechnic work, with no basic safety sentence.
 */
export function findLiveDangerIssue(
  draft: Parameters<typeof findTechnicalSourceTypeIssue>[0],
): GuardIssue | null {
  if (draft.actionType !== "TEST") return null;
  const text = draftBlob(draft);
  if (!isObviousLiveDanger(text) || hasBasicSafetyWording(text)) return null;
  return issue(
    "SAFETY",
    "SAFETY: živi SRS, HV ili pirotehnika traži jednu rečenicu što napraviti prije rada.",
  );
}

function isObviousLiveDanger(text: string): boolean {
  const n = normalizeForCompare(text);
  const srs =
    /\b(srs|airbag|zracni jastuk)\b/.test(n) &&
    /\b(konektor|connector|modul|module|pin|otpor|sond)\b/.test(n);
  const hv =
    /\b(narancasti kabel|narancast kabel|orange cable)\b/.test(n) ||
    (/\b(hv|visokonaponsk|visoki napon|inverter)\b/.test(n) &&
      /\b(kabel|konektor|inverter|orange|naranc)\b/.test(n));
  const pyro =
    /\bpiroteh/.test(n) ||
    (/\b(pretenzor|pretensioner)\b/.test(n) &&
      /\b(konektor|connector|pin|otpor|modul|module)\b/.test(n));
  return srs || hv || pyro;
}

function hasBasicSafetyWording(text: string): boolean {
  const n = normalizeForCompare(text);
  return /\b(iskljuc|odspoj|akumulator|baterij|ne diraj|ne spajaj|cekaj|upozoren|safety)\b/.test(
    n,
  );
}

/** Source-type honesty for technical claims. */
export function findSafetyAndTechnicalRuleIssue(
  draft: Parameters<typeof findTechnicalSourceTypeIssue>[0],
): GuardIssue | null {
  const technical = findTechnicalSourceTypeIssue(draft);
  if (!technical) return null;
  return issue("SPEC", technical);
}
