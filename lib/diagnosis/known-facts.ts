import type {
  DiagnosticCase,
  ExtractedCaseFacts,
  VehicleInfo,
} from "./types";

/** Extract explicit DTC / fault codes. Conservative — never invent P-codes from bare digits. */
export function extractDtcCodes(text: string): string[] {
  if (!text?.trim()) return [];
  const found = new Set<string>();

  // SAE / ISO + slightly longer manufacturer variants (e.g. C40186)
  for (const m of text.toUpperCase().matchAll(/\b[PCBU][0-9A-F]{4,6}\b/g)) {
    found.add(m[0]);
  }

  // Manufacturer-style alphanumeric codes (e.g. DF003)
  for (const m of text.toUpperCase().matchAll(/\bDF\s*([0-9]{2,4})\b/g)) {
    found.add(`DF${m[1]}`);
  }

  // Explicit "DTC/kod/code: …" captures — only accept clear alphanumeric forms
  for (const m of text.matchAll(
    /\b(?:dtc|kod(?:ovi)?|fault\s*code|greska|greška)\s*[:#-]?\s*([A-Za-z]{0,3}\d{2,6})\b/gi,
  )) {
    const raw = m[1].toUpperCase().replace(/\s+/g, "");
    if (
      /^[PCBU][0-9A-F]{4,6}$/.test(raw) ||
      /^DF\d{2,4}$/.test(raw) ||
      /^[A-Z]{1,3}\d{2,6}$/.test(raw)
    ) {
      found.add(raw);
    }
  }

  // "P-0299" / "P 0299" / "C-40186"
  for (const m of text
    .toUpperCase()
    .matchAll(/\b([PCBU])\s*[-–]?\s*([0-9A-F]{4,6})\b/g)) {
    found.add(`${m[1]}${m[2]}`);
  }

  return [...found];
}

const MEASUREMENT_WITH_UNIT_RE =
  /\d+(?:[.,]\d+)?\s*(?:ohm|bar|kPa|°C|mV|mA|Ω|V|A|%)/i;

function extractNumericMeasurements(text: string): string[] {
  return MEASUREMENT_WITH_UNIT_RE.test(text) ? [text] : [];
}

function uniqStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Deterministic facts from free text: DTCs + explicit numeric measurements only.
 * Vehicle/symptoms are owned by AI semanticUpdate wiring, not this layer.
 */
export function extractFactsFromText(text: string): ExtractedCaseFacts {
  const trimmed = text.trim();
  if (!trimmed) return {};

  const dtcs = extractDtcCodes(trimmed);
  const measurements = extractNumericMeasurements(trimmed);

  return {
    dtcs: dtcs.length ? dtcs : undefined,
    measurements: measurements.length ? measurements : undefined,
  };
}

/**
 * Refresh deterministic bags. DTCs may surface at any point, so complaint plus every
 * observation is scanned. Measurements come only from the intake complaint — a TEST
 * result becomes a measurement only when interpretTestResult() reports VALUE, which
 * the case-state layer decides.
 * Leaves vehicle/symptoms (and any legacy priorTests/observations bags) untouched.
 */
export function refreshExtractedFacts(
  diagnosticCase: DiagnosticCase,
  extraText?: string,
): ExtractedCaseFacts {
  const prior = diagnosticCase.extracted ?? {};

  const dtcs: string[] = [...(prior.dtcs ?? [])];
  const dtcTexts = [
    diagnosticCase.problemText,
    ...diagnosticCase.observations.map((o) => o.resultText),
    ...(extraText?.trim() ? [extraText] : []),
  ];
  for (const text of dtcTexts) {
    dtcs.push(...extractDtcCodes(text));
  }

  return {
    ...prior,
    dtcs: uniqStrings(dtcs).map((d) => d.toUpperCase()),
    measurements: uniqStrings(
      extractNumericMeasurements(diagnosticCase.problemText.trim()),
    ),
  };
}

export type KnownFactsSnapshot = {
  vehicle: VehicleInfo | null;
  knownDtcCodes: string[];
  symptoms: string[];
  measurements: string[];
  /** Explicit reminder for the model */
  doNotReAsk: string[];
};

export function buildKnownFactsSnapshot(
  diagnosticCase: DiagnosticCase,
): KnownFactsSnapshot {
  const extracted = refreshExtractedFacts(diagnosticCase);
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
    measurements: extracted.measurements ?? [],
    doNotReAsk,
  };
}
