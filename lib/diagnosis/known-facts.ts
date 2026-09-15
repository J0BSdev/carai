import type {
  DiagnosticCase,
  ExtractedMeasurement,
  Hypothesis,
  VehicleInfo,
} from "./types";

/**
 * Read-only view over `diagnosticCase.extracted` for prompts and guards.
 *
 * Nothing here parses free text: vehicle, symptoms, DTCs and measurements are
 * extracted by the diagnostic AI (semanticUpdate) and merged in llm-engine.
 * This snapshot is case state only — evidence status stays a guard decision.
 */
export type KnownFactsSnapshot = {
  vehicle: VehicleInfo | null;
  knownDtcCodes: string[];
  symptoms: string[];
  measurements: string[];
  /** Explicit reminder for the model */
  doNotReAsk: string[];
};

/** Legacy saved cases may hold plain strings instead of structured measurements. */
function measurementText(value: ExtractedMeasurement | string): string {
  if (typeof value === "string") return value.trim();
  return value.raw?.trim() ?? "";
}

export function buildKnownFactsSnapshot(
  diagnosticCase: DiagnosticCase,
): KnownFactsSnapshot {
  const extracted = diagnosticCase.extracted ?? {};
  const knownDtcCodes = extracted.dtcs ?? [];
  const doNotReAsk: string[] = [];

  if (knownDtcCodes.length > 0) {
    doNotReAsk.push(
      `DTC kodovi već poznati (${knownDtcCodes.join(", ")}): NE traži ponovno očitavanje/popis DTC-ova. Smiješ pitati status/opis/freeze-frame SAMO ako nisu poznati.`,
    );
  }
  if (
    extracted.vehicle?.make ||
    extracted.vehicle?.model ||
    extracted.vehicle?.year
  ) {
    doNotReAsk.push(
      "Podaci o vozilu djelomično poznati — ne pitaj ponovno ono što je već u vehicle.",
    );
  }

  return {
    vehicle: extracted.vehicle ?? null,
    knownDtcCodes,
    symptoms: extracted.symptoms ?? [],
    measurements: (extracted.measurements ?? [])
      .map(measurementText)
      .filter(Boolean),
    doNotReAsk,
  };
}

export function latestHypotheses(diagnosticCase: DiagnosticCase): Hypothesis[] {
  for (let i = diagnosticCase.steps.length - 1; i >= 0; i -= 1) {
    const h = diagnosticCase.steps[i]?.hypotheses;
    if (h && h.length > 0) return h;
  }
  return [];
}
