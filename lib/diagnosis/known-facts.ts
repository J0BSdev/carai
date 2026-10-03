import type { DiagnosticCase, Hypothesis, TechnicianOutcome, VehicleInfo } from "./types";

/** Read-only view of extracted case state for prompts. No instructions. */
export type KnownFactsSnapshot = {
  vehicle: VehicleInfo | null;
  knownDtcCodes: string[];
  symptoms: string[];
  measurements: string[];
};

export function buildKnownFactsSnapshot(
  diagnosticCase: DiagnosticCase,
): KnownFactsSnapshot {
  const extracted = diagnosticCase.extracted ?? {};
  return {
    vehicle: extracted.vehicle ?? null,
    knownDtcCodes: extracted.dtcs ?? [],
    symptoms: extracted.symptoms ?? [],
    measurements: (extracted.measurements ?? []).map((m) => m.trim()).filter(Boolean),
  };
}

/** Current-turn AI extraction only — never read from persisted case facts. */
export function isConfirmedTechnicianOutcome(
  outcome: TechnicianOutcome | null | undefined,
): boolean {
  return (
    outcome?.status === "FAULT_CONFIRMED" ||
    outcome?.status === "REPAIR_CONFIRMED"
  );
}

export function latestHypotheses(diagnosticCase: DiagnosticCase): Hypothesis[] {
  for (let i = diagnosticCase.steps.length - 1; i >= 0; i -= 1) {
    const h = diagnosticCase.steps[i]?.hypotheses;
    if (h && h.length > 0) return h;
  }
  return [];
}
