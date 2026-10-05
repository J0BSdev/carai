import type { TechnicalSourceType } from "./types";
import { issue, type GuardIssue } from "./guard-issue";

type TechnicalClaim = {
  sourceType: TechnicalSourceType;
  vehicleSpecific?: boolean;
};

/**
 * sourceType is a field the model sends. VERIFIED_* is never accepted.
 * A vehicle-specific claim cannot be labeled GENERAL_PRINCIPLE.
 * Free text is not scanned.
 */
export function findSafetyAndTechnicalRuleIssue(draft: {
  technicalClaims?: TechnicalClaim[] | null;
}): GuardIssue | null {
  for (const claim of draft.technicalClaims ?? []) {
    if (claim.vehicleSpecific === true && claim.sourceType === "GENERAL_PRINCIPLE") {
      return issue(
        "SPEC",
        "TECH SOURCE GUARD: vehicle-specific vrijednost ne smije biti GENERAL_PRINCIPLE. Koristi UNKNOWN ili MODEL_KNOWLEDGE.",
      );
    }
    if (claim.sourceType === "VERIFIED_OEM" || claim.sourceType === "VERIFIED_TECHNICAL") {
      return issue(
        "SPEC",
        "TECH SOURCE GUARD: VERIFIED_OEM/VERIFIED_TECHNICAL nije dozvoljen. Koristi UNKNOWN ili MODEL_KNOWLEDGE.",
      );
    }
  }
  return null;
}

/** Verifier routing: the model attached a technical claim. Does not read prose. */
export function draftHasSpecRisk(draft: {
  technicalClaims?: unknown[] | null;
}): boolean {
  return (draft.technicalClaims?.length ?? 0) > 0;
}
