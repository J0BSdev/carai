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

/** Words that must never become make/model (complaint fillers, not brands). */
const VEHICLE_STOPWORDS = new Set(
  [
    "da",
    "ne",
    "je",
    "su",
    "sam",
    "smo",
    "ste",
    "mi",
    "ti",
    "on",
    "ona",
    "ono",
    "i",
    "a",
    "u",
    "na",
    "za",
    "od",
    "do",
    "se",
    "sa",
    "po",
    "kod",
    "ima",
    "nema",
    "baca",
    "gubi",
    "radi",
    "nece",
    "neće",
    "krece",
    "kreće",
    "pali",
    "gasi",
    "auto",
    "auta",
    "vozilo",
    "kola",
    "problem",
    "kvar",
    "greska",
    "greška",
    "klijent",
    "kupac",
    "danas",
    "jutros",
    "jucer",
    "jučer",
    "vecer",
    "večer",
    "molim",
    "treba",
    "trebam",
    "zelim",
    "želim",
    "opet",
    "jos",
    "još",
    "vec",
    "već",
    "samo",
    "kad",
    "kada",
    "dok",
    "jer",
    "ali",
    "ili",
    "pa",
    "tako",
    "ovo",
    "taj",
    "ta",
    "to",
    "dtc",
    "motor",
    "engine",
    "tdi",
    "dci",
    "cdi",
    "hdi",
    "tfsi",
    "tsi",
    "diesel",
    "benzin",
    "godina",
    "godiste",
    "godište",
    "marka",
    "model",
  ].map((w) => w.toLowerCase()),
);

function isYearToken(t: string): boolean {
  return /^(19|20)\d{2}$/.test(t);
}

function isDtcToken(t: string): boolean {
  return /^[PCBU][0-9A-F]{4,6}$/i.test(t) || /^DF\d{2,4}$/i.test(t);
}

function isEngineToken(t: string): boolean {
  return /^(tdi|tdci|cdi|dci|hdi|crdi|tfsi|tsi|fsi|gdi|mpi|vti|d4d|diesel|benzin|petrol|l|lit|litara)$/i.test(
    t,
  );
}

function isDisplacementToken(t: string): boolean {
  return /^\d(?:[.,]\d)?$/.test(t);
}

function isStopwordToken(t: string): boolean {
  const n = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return VEHICLE_STOPWORDS.has(n) || VEHICLE_STOPWORDS.has(t.toLowerCase());
}

function isPlausibleMake(t: string): boolean {
  if (!t) return false;
  if (isStopwordToken(t) || isYearToken(t) || isDtcToken(t) || isEngineToken(t)) {
    return false;
  }
  // Short brand abbreviations (VW, SEAT as 4…)
  if (/^[A-Za-z]{2,4}$/.test(t) && t === t.toUpperCase()) return true;
  if (t.length < 3) return false;
  if (!/^[A-Za-zÀ-ž]{3,}$/.test(t)) return false;
  return true;
}

function isPlausibleModel(t: string): boolean {
  if (!t || t.length < 1) return false;
  if (isStopwordToken(t) || isYearToken(t) || isDtcToken(t) || isEngineToken(t)) {
    return false;
  }
  if (isDisplacementToken(t)) return false;
  // Model may be alphanumeric (320d, C-Max, Kangoo)
  return /^[A-Za-zÀ-ž][A-Za-z0-9À-ž-]{0,24}$/.test(t);
}

function titleCaseWord(t: string): string {
  if (!t) return t;
  if (/^[A-Z]{2,4}$/.test(t)) return t; // VW, BMW, SEAT
  if (/[0-9]/.test(t) && /[A-Za-z]/.test(t)) return t; // 320d / C-Max style
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function extractEngine(text: string): string | undefined {
  const patterns: RegExp[] = [
    /\b(\d(?:[.,]\d)?\s*(?:tdi|tdci|cdi|dci|hdi|crdi|tfsi|tsi|fsi|gdi|mpi|vti|d4d|skyactiv(?:-[\w]+)?))\b/i,
    /\b(\d(?:[.,]\d)\s*(?:l|lit|litara)?\s*(?:diesel|benzin|petrol|tdi|tdci|cdi|dci|hdi)?)\b/i,
    /\bmotor\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9.\-\/ ]{1,28})/i,
    /\bengine\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9.\-\/ ]{1,28})/i,
    /\bmotor\s+([A-Z]{1,3}\d{2,3}[A-Z]{0,2})\b/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m?.[1]) continue;
    let eng = m[1].replace(/\s+/g, " ").trim();
    eng =
      eng.split(/\s+(?:gubi|ne|ima|kod|dtc|greska|,)/i)[0]?.trim() ?? eng;
    if (/^[PCBU][0-9A-F]{4,6}$/i.test(eng)) continue;
    if (/^[PCBU]\d{3}/i.test(eng) && eng.length <= 5) continue;
    if (/^(19|20)\d{2}$/.test(eng)) continue;
    if (eng.length < 2 || eng.length > 32) continue;
    eng = eng.replace(
      /^(\d(?:[.,]\d)?)\s*(tdi|tdci|cdi|dci|hdi|crdi|tfsi|tsi|fsi|gdi|mpi|vti)$/i,
      (_: string, n: string, f: string) =>
        `${n.replace(",", ".")} ${f.toUpperCase()}`,
    );
    return eng;
  }
  return undefined;
}

function extractVehicle(text: string): VehicleInfo | undefined {
  const vehicle: VehicleInfo = {};
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) vehicle.year = Number(yearMatch[0]);

  const engine = extractEngine(text);
  if (engine) vehicle.engine = engine;

  const cleaned = text.replace(/[,\n;/|]+/g, " ").trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  // Skip leading fillers ("da", "baca", "ima"…) until a plausible make
  let makeIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (isPlausibleMake(tokens[i]!)) {
      makeIdx = i;
      break;
    }
  }

  if (makeIdx >= 0) {
    vehicle.make = titleCaseWord(tokens[makeIdx]!);
    const t1 = tokens[makeIdx + 1];
    if (t1 && isPlausibleModel(t1)) {
      const t2 = tokens[makeIdx + 2];
      // "Golf 7" / "Golf VII" — not "Kangoo 2014" and not displacement "2 0"
      if (
        t2 &&
        (/^\d{1,2}$/.test(t2) || /^(i{1,3}|iv|v|vi{0,3}|x+)$/i.test(t2)) &&
        !isYearToken(t2)
      ) {
        const next = (tokens[makeIdx + 3] ?? "").toLowerCase();
        const looksLikeDisplacement =
          /^0\d*$/.test(next) || isEngineToken(next);
        if (!looksLikeDisplacement) {
          vehicle.model = `${titleCaseWord(t1)} ${t2}`;
        } else {
          vehicle.model = titleCaseWord(t1);
        }
      } else {
        vehicle.model = titleCaseWord(t1);
      }
    }
  }

  return Object.keys(vehicle).length > 0 ? vehicle : undefined;
}

function extractSymptomLines(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  // Keep short complaint snippets; full text is also in originalComplaint
  if (t.length <= 240) return [t];
  return [t.slice(0, 237) + "…"];
}

/**
 * Structured facts from free text (intake or later mechanic messages).
 * Does not invent data — only extracts what is explicitly present.
 */
export function extractFactsFromText(text: string): ExtractedCaseFacts {
  const trimmed = text.trim();
  if (!trimmed) return {};

  const dtcs = extractDtcCodes(trimmed);
  const vehicle = extractVehicle(trimmed);
  const symptoms = extractSymptomLines(trimmed);

  const measurements: string[] = [];
  if (/\d+(?:[.,]\d+)?\s*(?:Ω|ohm|V|mV|A|mA|bar|kPa|°C|%)/i.test(trimmed)) {
    measurements.push(trimmed);
  }

  return {
    vehicle,
    symptoms: symptoms.length ? symptoms : undefined,
    dtcs: dtcs.length ? dtcs : undefined,
    measurements: measurements.length ? measurements : undefined,
    observations: undefined,
  };
}

function mergeVehicle(
  a?: VehicleInfo,
  b?: VehicleInfo,
): VehicleInfo | undefined {
  if (!a && !b) return undefined;
  return {
    make: b?.make || a?.make,
    model: b?.model || a?.model,
    year: b?.year ?? a?.year,
    engine: b?.engine || a?.engine,
    mileage: b?.mileage ?? a?.mileage,
  };
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
    symptoms: uniqStrings([...(base.symptoms ?? []), ...(incoming.symptoms ?? [])]),
    dtcs: uniqStrings([...(base.dtcs ?? []), ...(incoming.dtcs ?? [])]).map((d) =>
      d.toUpperCase(),
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

/** Recompute extracted facts from complaint + all observations. */
export function refreshExtractedFacts(
  diagnosticCase: DiagnosticCase,
  extraText?: string,
): ExtractedCaseFacts {
  let merged: ExtractedCaseFacts = { ...(diagnosticCase.extracted ?? {}) };
  merged = mergeExtractedFacts(
    merged,
    extractFactsFromText(diagnosticCase.problemText),
  );
  for (const obs of diagnosticCase.observations) {
    merged = mergeExtractedFacts(merged, extractFactsFromText(obs.resultText));
  }
  if (extraText?.trim()) {
    merged = mergeExtractedFacts(merged, extractFactsFromText(extraText));
  }
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
