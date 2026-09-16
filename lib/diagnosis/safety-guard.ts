import type { DiagnosticCase, TechnicalSourceType } from "./types";
import { extractReferenceSpecClaims } from "./spec-guard";
import { draftBlob, normalizeForCompare } from "./text";

export type TechnicalClaimPayload = {
  claim?: string | null;
  valueText?: string | null;
  sourceType?: string | null;
  vehicleSpecific?: boolean | null;
};

export type SafetyPreconditionsPayload = {
  category?: string | null;
  warnings?: string[] | null;
  requiredSteps?: string[] | null;
  needsVerifiedProcedure?: boolean | null;
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
    /(za ovo vozilo|na ovom vozilu|oem|tvornick|tvorničk|specifikac|pin\s*\d|pinout|moment|torque|cekaj \d|čekaj \d|\d+\s*(min|sek|s)\b)/.test(
      n,
    ) || extractReferenceSpecClaims(text).length > 0
  );
}

/**
 * Enforce sourceType honesty for technical claims/specs.
 * Vehicle-specific values cannot be GENERAL_PRINCIPLE.
 * MODEL_KNOWLEDGE / UNKNOWN cannot be treated as verified specs.
 * AI cannot self-label VERIFIED_* without case verifiedTechnicalSpecs.
 */
export function findTechnicalSourceTypeIssue(
  diagnosticCase: DiagnosticCase,
  draft: {
    actionType?: string;
    content?: string;
    rationale?: string;
    expectedResultHint?: string | null;
    confirmedFault?: string | null;
    facts?: string[] | null;
    evidence?: string[] | null;
    technicalClaims?: TechnicalClaimPayload[] | null;
  },
): string | null {
  const text = draftBlob(draft);
  const claims = Array.isArray(draft.technicalClaims)
    ? draft.technicalClaims
    : [];
  const hasCaseVerified =
    (diagnosticCase.verifiedTechnicalSpecs?.length ?? 0) > 0;

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
        "Koristi VERIFIED_OEM/VERIFIED_TECHNICAL ili UNKNOWN/MODEL_KNOWLEDGE (bez tretiranja kao verified)."
      );
    }

    if (
      (sourceType === "VERIFIED_OEM" || sourceType === "VERIFIED_TECHNICAL") &&
      !hasCaseVerified
    ) {
      return (
        "TECH SOURCE GUARD: AI ne smije označiti sourceType kao VERIFIED_OEM/VERIFIED_TECHNICAL " +
        "kad CASE STATE.verifiedTechnicalSpecs nema taj podatak. Koristi UNKNOWN ili MODEL_KNOWLEDGE."
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

  // Implicit vehicle-specific numeric claims in text without honest source typing
  const implicitClaims = extractReferenceSpecClaims(text);
  if (implicitClaims.length > 0) {
    const hasVerifiedTyped = claims.some((c) => {
      const st = normalizeSourceType(c.sourceType);
      return st === "VERIFIED_OEM" || st === "VERIFIED_TECHNICAL";
    });
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

    // If asserting concrete numeric OEM-like fact without verified source typing → reject
    if (
      !hasVerifiedTyped &&
      !hasHonestUnknown &&
      /(mora biti|trebalo bi|ocekivan|očekivan|oem|za ovo vozilo|na ovom vozilu)/i.test(
        text,
      )
    ) {
      return (
        "TECH SOURCE GUARD: tehnička tvrdnja/spec mora imati sourceType. " +
        "MODEL_KNOWLEDGE/UNKNOWN nisu verified; bez VERIFIED_OEM/VERIFIED_TECHNICAL ne tvrdi vehicle-specific vrijednost."
      );
    }
  }

  return null;
}

type SafetyCategory = "SRS" | "HV" | "BRAKES" | "OTHER_CRITICAL" | null;

function detectSafetyCategory(normalized: string): SafetyCategory {
  if (
    /(srs|airbag|jastuk|pyrotechn|pretension|napinjac|napinjač|clockspring|spiralni kabel)/.test(
      normalized,
    )
  ) {
    return "SRS";
  }
  if (
    /(high voltage|\bhv\b|visoki napon|hibrid|hybrid|inverter|traction battery|ev battery|orange cable|narancast|narančast)/.test(
      normalized,
    )
  ) {
    return "HV";
  }
  if (
    /(kocnic|kočnic|brake|abs modulator|hidraulic|hidrauli)/.test(normalized) &&
    /(otvori|rastavi|skini|zamijeni|bleed|odzraci|odzrači|tlak|linij)/.test(
      normalized,
    )
  ) {
    return "BRAKES";
  }
  if (
    /(pyrotechn|eksploziv|gas generator|seatbelt tensioner)/.test(normalized)
  ) {
    return "OTHER_CRITICAL";
  }
  return null;
}

function involvesConnectorOrModuleWork(normalized: string): boolean {
  return /(konektor|connector|modul|ecu|unit|uticnica|utikač|pin|snop|zica|žica)/.test(
    normalized,
  );
}

function inventsVehicleSpecificWaitOrProcedure(normalized: string): boolean {
  const inventsWait =
    /(pricekaj|pričekaj|cekaj|čekaj|wait)\s+\d+\s*(min|minut|sek|s|second)/.test(
      normalized,
    ) || /\d+\s*(min|minut)\s*(prije|before|odspoj|nakon)/.test(normalized);
  const admitsUnverified =
    /(verificiran(a|u)? procedur|verified procedure|nije verificiran|tocan postupak nije|točan postupak nije|provjeri oem)/.test(
      normalized,
    );
  return inventsWait && !admitsUnverified;
}

/** Any short practical caution — AI owns the wording. */
function hasAnySafetyLanguage(normalized: string): boolean {
  return /(odspoji|deaktiv|iskljuc|isključ|ppe|rukavic|izol|service plug|service disconnect|prije rada|napajan.*prije|baterij.*prije|akumulator.*prije|verificiran\w* procedur|needs verified procedure)/.test(
    normalized,
  );
}

function isClearlyLiveSrsWork(normalized: string): boolean {
  const category = detectSafetyCategory(normalized);
  return (
    (category === "SRS" || category === "OTHER_CRITICAL") &&
    involvesConnectorOrModuleWork(normalized)
  );
}

function isClearlyLiveHvWork(normalized: string): boolean {
  if (detectSafetyCategory(normalized) !== "HV") return false;
  return /(orange cable|narancast|narančast|inverter|service plug|service disconnect|traction battery|visokonaponsk)/.test(
    normalized,
  );
}

function draftSafetyBlob(draft: {
  content?: string;
  rationale?: string;
  expectedResultHint?: string | null;
  safetyPreconditions?: SafetyPreconditionsPayload | null;
}): string {
  return normalizeForCompare(
    [
      draftBlob(draft),
      draft.safetyPreconditions?.category,
      ...(draft.safetyPreconditions?.warnings ?? []),
      ...(draft.safetyPreconditions?.requiredSteps ?? []),
      draft.safetyPreconditions?.needsVerifiedProcedure
        ? "needs verified procedure"
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Light fail-safe only: clearly live high-energy TESTs with no caution at all,
 * or invented numeric wait times. AI owns whether/how to warn on ordinary tests.
 */
export function findSafetyCriticalTestIssue(draft: {
  actionType?: string;
  content?: string;
  rationale?: string;
  expectedResultHint?: string | null;
  safetyPreconditions?: SafetyPreconditionsPayload | null;
}): string | null {
  if (draft.actionType !== "TEST") return null;

  const normalized = normalizeForCompare(draftBlob(draft));
  if (inventsVehicleSpecificWaitOrProcedure(normalized)) {
    return (
      "SAFETY REJECT: ne izmišljaj vehicle-specific wait/OEM postupak. " +
      "Jedna rečenica da treba verificiranu proceduru — bez izmišljenih minuta."
    );
  }

  const safetyBlob = draftSafetyBlob(draft);
  if (hasAnySafetyLanguage(safetyBlob)) return null;

  if (isClearlyLiveSrsWork(normalized)) {
    return (
      "SAFETY REJECT: živi SRS/airbag rad na konektoru/modulu treba 1 kratku praktičnu rečenicu " +
      "(odspoji napajanje prije rada). Bez checklisti i bez izmišljenog wait time."
    );
  }

  if (isClearlyLiveHvWork(normalized)) {
    return (
      "SAFETY REJECT: živi HV rad treba 1 kratku praktičnu rečenicu " +
      "(izolacija / odspajanje prije rada). Ne izmišljaj OEM wait."
    );
  }

  return null;
}

/** True when TEST text touches SRS/HV/brakes/other safety-critical work (for selective verifier). */
export function isSafetyCriticalTestDraft(draft: {
  actionType?: string;
  content?: string;
  rationale?: string;
  expectedResultHint?: string | null;
  confirmedFault?: string | null;
  facts?: string[] | null;
  evidence?: string[] | null;
}): boolean {
  if (draft.actionType !== "TEST") return false;
  return detectSafetyCategory(normalizeForCompare(draftBlob(draft))) != null;
}

/** Combined safety + technical source guard. */
export function findSafetyAndTechnicalRuleIssue(
  diagnosticCase: DiagnosticCase,
  draft: {
    actionType?: string;
    content?: string;
    rationale?: string;
    expectedResultHint?: string | null;
    confirmedFault?: string | null;
    facts?: string[] | null;
    evidence?: string[] | null;
    technicalClaims?: TechnicalClaimPayload[] | null;
    safetyPreconditions?: SafetyPreconditionsPayload | null;
  },
): string | null {
  return (
    findTechnicalSourceTypeIssue(diagnosticCase, draft) ??
    findSafetyCriticalTestIssue(draft)
  );
}
