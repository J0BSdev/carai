import type { DiagnosticCase } from "./types";
import { extractReferenceSpecClaims } from "./spec-guard";

export type TechnicalSourceType =
  | "VERIFIED_OEM"
  | "VERIFIED_TECHNICAL"
  | "GENERAL_PRINCIPLE"
  | "MODEL_KNOWLEDGE"
  | "UNKNOWN";

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

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9čćžšđ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function draftText(draft: {
  content?: string;
  rationale?: string;
  expectedResultHint?: string | null;
  confirmedFault?: string | null;
  facts?: string[] | null;
  evidence?: string[] | null;
}): string {
  return [
    draft.content,
    draft.rationale,
    draft.expectedResultHint,
    draft.confirmedFault,
    ...(draft.facts ?? []),
    ...(draft.evidence ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeSourceType(raw: string | null | undefined): TechnicalSourceType | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (SOURCE_TYPES.has(key as TechnicalSourceType)) {
    return key as TechnicalSourceType;
  }
  return null;
}

function looksVehicleSpecificClaim(text: string): boolean {
  const n = normalize(text);
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
  const text = draftText(draft);
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
    const n = normalize(text);
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

function hasSrsDeactivationWarning(normalized: string): boolean {
  return (
    /(deaktiv|iskljuc|isključ|odspoji|odspoj|disconnect).{0,40}(srs|airbag|jastuk|napajanj|baterij|akumulator)/.test(
      normalized,
    ) ||
    /(srs|airbag|jastuk).{0,40}(deaktiv|iskljuc|isključ|odspoji|odspoj|disconnect)/.test(
      normalized,
    ) ||
    /(odspoji baterij|odspoji akumulator|iskljuci paljenje i odspoji|prije rada.*napajan)/.test(
      normalized,
    )
  );
}

function inventsVehicleSpecificWaitOrProcedure(normalized: string): boolean {
  // Invented wait times / OEM procedure specifics without verified caveat
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

function hasHvSafetyBasics(normalized: string): boolean {
  return (
    /(izol|hv isolat|service plug|service disconnect|ppe|rukavic|visokonapon)/.test(
      normalized,
    ) &&
    /(odspoji|deaktiv|iskljuc|isključ|provjeri napon|discharge|praznjen)/.test(
      normalized,
    )
  );
}

function hasBrakeSafetyBasics(normalized: string): boolean {
  return /(osiguraj vozilo|podupri|stand|odzraci|odzrači|tlak.*pusti|depressur|sigurnos)/.test(
    normalized,
  );
}

/**
 * Reject safety-critical TESTs missing mandatory safety preconditions.
 */
export function findSafetyCriticalTestIssue(draft: {
  actionType?: string;
  content?: string;
  rationale?: string;
  expectedResultHint?: string | null;
  safetyPreconditions?: SafetyPreconditionsPayload | null;
}): string | null {
  if (draft.actionType !== "TEST") return null;

  const text = draftText(draft);
  const normalized = normalize(text);
  const category = detectSafetyCategory(normalized);
  if (!category) return null;

  const safetyBlob = normalize(
    [
      text,
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

  const prefix =
    "SAFETY REJECT: safety-critical TEST ne smije se prikazati bez obaveznih safety preconditions. Regeneriraj TEST sa sigurnosnim koracima. ";

  if (category === "SRS") {
    if (
      involvesConnectorOrModuleWork(normalized) &&
      !hasSrsDeactivationWarning(safetyBlob)
    ) {
      return (
        prefix +
        "SRS/airbag rad na konektorima/modulu zahtijeva jasno upozorenje: deaktivacija sustava / odspajanje napajanja PRIJE rada."
      );
    }
    if (inventsVehicleSpecificWaitOrProcedure(normalized)) {
      return (
        prefix +
        "Ne izmišljaj vehicle-specific SRS vrijeme čekanja/postupak. Označi needsVerifiedProcedure=true i reci da treba verificiranu proceduru."
      );
    }
  }

  if (category === "HV" && !hasHvSafetyBasics(safetyBlob)) {
    return (
      prefix +
      "HV/hybrid rad zahtijeva sigurnosne preconditions (izolacija HV, PPE, provjera napona/pražnjenje). Ne izmišljaj OEM wait time — traži verificiranu proceduru ako treba."
    );
  }

  if (category === "BRAKES" && !hasBrakeSafetyBasics(safetyBlob)) {
    return (
      prefix +
      "Rad na kočnicama zahtijeva sigurnosne preconditions (osiguranje vozila / kontrola tlaka / pravilni postupak). Regeneriraj TEST sa safety koracima."
    );
  }

  if (category === "OTHER_CRITICAL" && !hasSrsDeactivationWarning(safetyBlob)) {
    return (
      prefix +
      "Safety-critical rad zahtijeva jasne safety preconditions prije izvođenja."
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
  return detectSafetyCategory(normalize(draftText(draft))) != null;
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
