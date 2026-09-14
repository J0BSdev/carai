import type {
  DiagnosticCase,
  ExtractedCaseFacts,
  VehicleInfo,
} from "./types";

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9čćžšđ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract DTC / fault codes without hardcoding specific vehicles. */
export function extractDtcCodes(text: string): string[] {
  if (!text?.trim()) return [];
  const found = new Set<string>();

  // SAE / ISO + slightly longer manufacturer variants (e.g. C40186)
  for (const m of text.toUpperCase().matchAll(/\b[PCBU][0-9A-F]{4,6}\b/g)) {
    found.add(m[0]);
  }

  // Manufacturer-style alphanumeric codes (e.g. DF003), not hardcoded to one brand
  for (const m of text.toUpperCase().matchAll(/\bDF\s*([0-9]{2,4})\b/g)) {
    found.add(`DF${m[1]}`);
  }

  // Explicit "DTC/kod/code: XYZ123" captures
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
    } else if (/^\d{4}$/.test(raw)) {
      found.add(`P${raw}`);
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
  /\d+(?:[.,]\d+)?\s*(?:Ω|ohm|V|mV|A|mA|bar|kPa|°C|%)/i;

function extractNumericMeasurements(text: string): string[] {
  return MEASUREMENT_WITH_UNIT_RE.test(text) ? [text] : [];
}

/**
 * Deterministic facts from free text (intake or observation).
 * Only DTCs + explicit numeric measurements — no semantic vehicle/symptoms parsing.
 * Vehicle/symptoms come from the diagnostic AI draft into diagnosticCase.extracted.
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
 * Observation.resultText may only contribute DTCs + numeric measurements.
 * Never vehicle or symptoms.
 */
function extractFactsFromObservation(text: string): ExtractedCaseFacts {
  return extractFactsFromText(text);
}

/** Prefer `primary`; fill gaps from `fallback`. Never overwrite known fields. */
function mergeVehicle(
  primary?: VehicleInfo,
  fallback?: VehicleInfo,
): VehicleInfo | undefined {
  if (!primary && !fallback) return undefined;
  const merged: VehicleInfo = {
    make: primary?.make || fallback?.make,
    model: primary?.model || fallback?.model,
    year: primary?.year ?? fallback?.year,
    engine: primary?.engine || fallback?.engine,
    mileage: primary?.mileage ?? fallback?.mileage,
  };
  return Object.values(merged).some((v) => v != null && v !== "")
    ? merged
    : undefined;
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

/** Merge newly extracted facts into existing case.extracted (non-destructive). */
export function mergeExtractedFacts(
  existing: ExtractedCaseFacts | undefined,
  incoming: ExtractedCaseFacts,
): ExtractedCaseFacts {
  const base = existing ?? {};
  return {
    vehicle: mergeVehicle(base.vehicle, incoming.vehicle),
    symptoms: uniqStrings([
      ...(base.symptoms ?? []),
      ...(incoming.symptoms ?? []),
    ]),
    dtcs: uniqStrings([...(base.dtcs ?? []), ...(incoming.dtcs ?? [])]).map(
      (d) => d.toUpperCase(),
    ),
    priorTests: uniqStrings([
      ...(base.priorTests ?? []),
      ...(incoming.priorTests ?? []),
    ]),
    observations: uniqStrings([
      ...(base.observations ?? []),
      ...(incoming.observations ?? []),
    ]),
    measurements: uniqStrings([
      ...(base.measurements ?? []),
      ...(incoming.measurements ?? []),
    ]),
  };
}

/**
 * Refresh deterministic bags (DTCs, measurements) from complaint + observations.
 * Existing structured vehicle/symptoms on diagnosticCase.extracted are authoritative
 * and are never overwritten by observation text.
 */
export function refreshExtractedFacts(
  diagnosticCase: DiagnosticCase,
  extraText?: string,
): ExtractedCaseFacts {
  const prior = diagnosticCase.extracted ?? {};

  let merged: ExtractedCaseFacts = {
    vehicle: prior.vehicle,
    symptoms: prior.symptoms,
    priorTests: prior.priorTests,
    observations: prior.observations,
    dtcs: prior.dtcs,
    measurements: prior.measurements,
  };

  merged = mergeExtractedFacts(
    merged,
    extractFactsFromText(diagnosticCase.problemText),
  );

  for (const obs of diagnosticCase.observations) {
    merged = mergeExtractedFacts(
      merged,
      extractFactsFromObservation(obs.resultText),
    );
  }
  if (extraText?.trim()) {
    merged = mergeExtractedFacts(
      merged,
      extractFactsFromObservation(extraText),
    );
  }

  // Lock semantic fields: observations / deterministic extract must not change them.
  merged.vehicle = prior.vehicle;
  merged.symptoms = prior.symptoms;

  return merged;
}

export type KnownFactsSnapshot = {
  vehicle: VehicleInfo | null;
  knownDtcCodes: string[];
  symptoms: string[];
  observations: string[];
  measurements: string[];
  priorTests: string[];
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
  if (extracted.vehicle?.make || extracted.vehicle?.model || extracted.vehicle?.year) {
    doNotReAsk.push(
      "Podaci o vozilu djelomično poznati — ne pitaj ponovno ono što je već u vehicle.",
    );
  }

  return {
    vehicle: extracted.vehicle ?? null,
    knownDtcCodes,
    symptoms: extracted.symptoms ?? [],
    observations: extracted.observations ?? [],
    measurements: extracted.measurements ?? [],
    priorTests: extracted.priorTests ?? [],
    doNotReAsk,
  };
}

function asksForDtcInventoryOrRescan(normalized: string): boolean {
  const asksInventory =
    /(ocitaj|ocitati|procitaj|skenir|scan|provjeri).{0,40}(dtc|kod|fault|gresk)/.test(
      normalized,
    ) ||
    /(ima li|postoji li|koji su|navedi|popis).{0,40}(dtc|kod|fault|gresk)/.test(
      normalized,
    ) ||
    /(dtc|kodovi|fault codes).{0,40}(ocitaj|ocitati|skenir|scan)/.test(
      normalized,
    );

  if (!asksInventory) return false;

  // Detail questions about an already-known code are allowed
  const asksDetailOnly =
    /(status|opis|znacenj|značenj|freeze|pending|confirmed|aktiv|povijest|frame).{0,30}(dtc|kod|df\d|[pcbu][0-9a-f]{4})/.test(
      normalized,
    ) ||
    /(status|opis).{0,20}(df\d|[pcbu][0-9a-f]{4})/.test(normalized);

  return !asksDetailOnly;
}

function asksForAlreadyKnownVehicle(normalized: string, vehicle: VehicleInfo): boolean {
  const asksMakeModel =
    /(koja|koje|koji).{0,20}(marka|model|godina|vozilo)/.test(normalized) ||
    /(potvrdi|navedi).{0,30}(marka|model|godina|motor|kilometraz)/.test(
      normalized,
    ) ||
    /(marka|model|godina).{0,20}(vozila|auta)/.test(normalized);

  if (!asksMakeModel) return false;

  const knownBits = [vehicle.make, vehicle.model, vehicle.year?.toString()].filter(
    Boolean,
  ).length;
  // Only block if we already have usable identity
  return knownBits >= 2;
}

/**
 * Reject ASK/TEST that re-request information already present in known facts.
 * Allows asking for unknown details about a known code (status/description).
 */
export function findAlreadyKnownInfoIssue(
  diagnosticCase: DiagnosticCase,
  draft: { actionType?: string; content?: string; rationale?: string },
): string | null {
  if (draft.actionType !== "ASK" && draft.actionType !== "TEST") return null;
  const content = `${draft.content ?? ""} ${draft.rationale ?? ""}`.trim();
  if (!content) return null;

  const known = buildKnownFactsSnapshot(diagnosticCase);
  const normalized = normalizeForCompare(content);

  if (known.knownDtcCodes.length > 0 && asksForDtcInventoryOrRescan(normalized)) {
    return (
      `KNOWN FACTS: DTC kodovi su već poznati (${known.knownDtcCodes.join(", ")}). ` +
      "Ne traži ponovno očitavanje/popis DTC-ova. " +
      "Ako treba detalj, pitaj status/opis konkretnog poznatog koda — ili odaberi sljedeći dijagnostički TEST na temelju poznatih kodova."
    );
  }

  // If draft asks "which DTC" while codes known
  if (
    known.knownDtcCodes.length > 0 &&
    /(koji|kakav).{0,15}(dtc|kod|gresk)/.test(normalized) &&
    !/(status|opis)/.test(normalized)
  ) {
    return (
      `KNOWN FACTS: već postoje DTC kodovi (${known.knownDtcCodes.join(", ")}). Ne pitaj koji je kod.`
    );
  }

  if (known.vehicle && asksForAlreadyKnownVehicle(normalized, known.vehicle)) {
    return (
      "KNOWN FACTS: podaci o vozilu su već u case stateu. Ne pitaj ponovno marku/model/godinu koje su poznate."
    );
  }

  return null;
}
