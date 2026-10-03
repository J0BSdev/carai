import type { LlmStepPayload, VerifierCorrectionPatch } from "./providers";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseVerifierIssues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const issues: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    issues.push(item);
    if (issues.length >= 2) break;
  }
  return issues;
}

function readStringOrNull(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null || typeof value === "string") {
    return { ok: true, value };
  }
  return { ok: false };
}

function readBooleanOrNull(
  value: unknown,
): { ok: true; value: boolean | null } | { ok: false } {
  if (value === null || typeof value === "boolean") {
    return { ok: true, value };
  }
  return { ok: false };
}

function readStringArrayOrNull(
  value: unknown,
): { ok: true; value: string[] | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return { ok: false };
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { ok: false };
    items.push(item);
  }
  return { ok: true, value: items };
}

function parseTechnicalClaimsField(
  raw: unknown,
): LlmStepPayload["technicalClaims"] | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const claims: NonNullable<LlmStepPayload["technicalClaims"]> = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return undefined;
    const claim: NonNullable<LlmStepPayload["technicalClaims"]>[number] = {};
    if ("claim" in item) {
      const parsed = readStringOrNull(item.claim);
      if (!parsed.ok) return undefined;
      claim.claim = parsed.value;
    }
    if ("valueText" in item) {
      const parsed = readStringOrNull(item.valueText);
      if (!parsed.ok) return undefined;
      claim.valueText = parsed.value;
    }
    if ("sourceType" in item) {
      const parsed = readStringOrNull(item.sourceType);
      if (!parsed.ok) return undefined;
      claim.sourceType = parsed.value;
    }
    if ("vehicleSpecific" in item) {
      const parsed = readBooleanOrNull(item.vehicleSpecific);
      if (!parsed.ok) return undefined;
      claim.vehicleSpecific = parsed.value;
    }
    claims.push(claim);
  }
  return claims;
}

function parseSafetyPreconditionsField(
  raw: unknown,
): LlmStepPayload["safetyPreconditions"] | undefined {
  if (raw === null) return null;
  if (!isPlainObject(raw)) return undefined;
  const parsed: NonNullable<LlmStepPayload["safetyPreconditions"]> = {};
  if ("category" in raw) {
    const category = readStringOrNull(raw.category);
    if (!category.ok) return undefined;
    parsed.category = category.value;
  }
  if ("warnings" in raw) {
    const warnings = readStringArrayOrNull(raw.warnings);
    if (!warnings.ok) return undefined;
    parsed.warnings = warnings.value;
  }
  if ("requiredSteps" in raw) {
    const steps = readStringArrayOrNull(raw.requiredSteps);
    if (!steps.ok) return undefined;
    parsed.requiredSteps = steps.value;
  }
  if ("needsVerifiedProcedure" in raw) {
    const flag = readBooleanOrNull(raw.needsVerifiedProcedure);
    if (!flag.ok) return undefined;
    parsed.needsVerifiedProcedure = flag.value;
  }
  return parsed;
}

export function sanitizeVerifierCorrection(
  raw: unknown,
): VerifierCorrectionPatch | null {
  if (!isPlainObject(raw)) return null;
  const patch: VerifierCorrectionPatch = {};

  if ("content" in raw && typeof raw.content === "string") {
    patch.content = raw.content;
  }
  if ("rationale" in raw && typeof raw.rationale === "string") {
    patch.rationale = raw.rationale;
  }
  if ("expectedResultHint" in raw) {
    const parsed = readStringOrNull(raw.expectedResultHint);
    if (parsed.ok) patch.expectedResultHint = parsed.value;
  }
  if ("confirmedFault" in raw) {
    const parsed = readStringOrNull(raw.confirmedFault);
    if (parsed.ok) patch.confirmedFault = parsed.value;
  }
  if ("diagnosisCertainty" in raw) {
    const parsed = readStringOrNull(raw.diagnosisCertainty);
    if (parsed.ok) patch.diagnosisCertainty = parsed.value;
  }
  if ("diagnosisConfidence" in raw) {
    const n = raw.diagnosisConfidence;
    if (typeof n === "number" && Number.isFinite(n)) {
      patch.diagnosisConfidence = Math.max(0, Math.min(100, n));
    }
  }
  if (
    "insufficientEvidence" in raw &&
    typeof raw.insufficientEvidence === "boolean"
  ) {
    patch.insufficientEvidence = raw.insufficientEvidence;
  }
  if ("technicalClaims" in raw) {
    const claims = parseTechnicalClaimsField(raw.technicalClaims);
    if (claims !== undefined) patch.technicalClaims = claims;
  }
  if ("safetyPreconditions" in raw) {
    const safety = parseSafetyPreconditionsField(raw.safetyPreconditions);
    if (safety !== undefined) patch.safetyPreconditions = safety;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

