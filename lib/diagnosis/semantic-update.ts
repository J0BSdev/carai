import type { LlmStepPayload } from "./providers";
import type {
  DiagnosticCase,
  ExtractedCaseFacts,
  TechnicianOutcome,
  TechnicianOutcomeStatus,
  VehicleInfo,
} from "./types";

/** Turn-scoped facts. technicianOutcome is never written onto the case. */
export type TurnFacts = {
  allowTechnicianOutcome: boolean;
  technicianOutcome: TechnicianOutcome | null;
  extracted: ExtractedCaseFacts | null;
};

function parseAiYear(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const y = Math.round(value);
    return y >= 1900 && y <= 2100 ? y : undefined;
  }
  if (typeof value === "string" && /^(19|20)\d{2}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function normalizeSymptomList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
}

function dedupeSymptoms(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Type validation only — the code is stored as stated, no namespace guessing. */
function normalizeAiDtcList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const code = v.trim().replace(/\s+/g, " ").toUpperCase();
    if (!code || code.length > 24) continue;
    out.push(code);
  }
  return out;
}

/** Type validation only — `raw` stays verbatim, nothing is re-parsed from prose. */
function normalizeAiMeasurementList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    if (!v || typeof v !== "object") continue;
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (!text || text.length > 120) continue;
    out.push(text);
  }
  return out;
}

const TECHNICIAN_OUTCOME_STATUSES: TechnicianOutcomeStatus[] = [
  "FAULT_CONFIRMED",
  "REPAIR_CONFIRMED",
  "NOT_CONFIRMED",
];

/** Type-validate only — never infers confirmation from mechanic prose. */
function parseTechnicianOutcome(raw: unknown): TechnicianOutcome | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const statusRaw =
    typeof row.status === "string"
      ? row.status.trim().toUpperCase().replace(/[\s-]+/g, "_")
      : "";
  if (
    !TECHNICIAN_OUTCOME_STATUSES.includes(statusRaw as TechnicianOutcomeStatus)
  ) {
    return undefined;
  }
  const outcome: TechnicianOutcome = {
    status: statusRaw as TechnicianOutcomeStatus,
  };
  if (typeof row.fault === "string" && row.fault.trim()) {
    outcome.fault = row.fault.trim();
  }
  if (typeof row.basis === "string" && row.basis.trim()) {
    outcome.basis = row.basis.trim();
  }
  return outcome;
}

/**
 * Merge an explicit semanticUpdate into case facts. Pure — returns null when the
 * delta changes nothing. The model is the semantic extractor; this only validates
 * types, dedupes and merges.
 */
function mergeSemanticUpdate(
  prior: ExtractedCaseFacts,
  update: NonNullable<LlmStepPayload["semanticUpdate"]>,
): ExtractedCaseFacts | null {
  let vehicle = prior.vehicle;
  let symptoms = [...(prior.symptoms ?? [])];
  let dtcs = [...(prior.dtcs ?? [])];
  let measurements = [...(prior.measurements ?? [])];
  let changed = false;

  const rawVehicle = update.vehicle;
  if (rawVehicle && typeof rawVehicle === "object") {
    const patch: VehicleInfo = { ...vehicle };
    let vehicleChanged = false;

    const setField = <K extends keyof VehicleInfo>(
      key: K,
      value: VehicleInfo[K] | undefined,
    ) => {
      if (value === undefined || patch[key] === value) return;
      patch[key] = value;
      vehicleChanged = true;
    };

    if (typeof rawVehicle.make === "string" && rawVehicle.make.trim()) {
      setField("make", rawVehicle.make.trim());
    }
    if (typeof rawVehicle.model === "string" && rawVehicle.model.trim()) {
      setField("model", rawVehicle.model.trim());
    }
    setField("year", parseAiYear(rawVehicle.year));
    if (typeof rawVehicle.engine === "string" && rawVehicle.engine.trim()) {
      setField("engine", rawVehicle.engine.trim());
    }
    if (
      typeof rawVehicle.mileage === "number" &&
      Number.isFinite(rawVehicle.mileage)
    ) {
      setField("mileage", Math.round(rawVehicle.mileage));
    }

    if (vehicleChanged) {
      vehicle = patch;
      changed = true;
    }
  }

  const toAdd = normalizeSymptomList(update.symptomsAdd);
  if (toAdd.length) {
    const merged = dedupeSymptoms([...symptoms, ...toAdd]);
    if (merged.length !== symptoms.length) {
      symptoms = merged;
      changed = true;
    }
  }

  const toRemove = normalizeSymptomList(update.symptomsRemove);
  if (toRemove.length) {
    const removeKeys = new Set(toRemove.map((s) => s.toLowerCase()));
    const next = symptoms.filter((s) => !removeKeys.has(s.toLowerCase()));
    if (next.length !== symptoms.length) {
      symptoms = next;
      changed = true;
    }
  }

  const dtcsToAdd = normalizeAiDtcList(update.dtcsAdd);
  if (dtcsToAdd.length) {
    const merged = dedupeSymptoms([...dtcs, ...dtcsToAdd]);
    if (merged.length !== dtcs.length) {
      dtcs = merged;
      changed = true;
    }
  }

  const measurementsToAdd = normalizeAiMeasurementList(update.measurementsAdd);
  if (measurementsToAdd.length) {
    const merged = dedupeSymptoms([...measurements, ...measurementsToAdd]);
    if (merged.length !== measurements.length) {
      measurements = merged;
      changed = true;
    }
  }

  if (!changed) return null;

  return {
    vehicle,
    symptoms: symptoms.length ? symptoms : undefined,
    dtcs: dtcs.length ? dtcs : undefined,
    measurements: measurements.length ? measurements : undefined,
  };
}

/**
 * Fold a diagnostic draft's semanticUpdate into the turn. Only drafts from the
 * diagnostic model reach this, so the verifier never acts as extractor.
 */
export function recordSemanticUpdate(
  turn: TurnFacts,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): void {
  if (turn.allowTechnicianOutcome) {
    turn.technicianOutcome =
      parseTechnicianOutcome(draft.semanticUpdate?.technicianOutcome) ?? null;
  } else {
    turn.technicianOutcome = null;
  }

  const update = draft.semanticUpdate;
  if (!update || typeof update !== "object") return;
  const merged = mergeSemanticUpdate(
    turn.extracted ?? diagnosticCase.extracted ?? {},
    update,
  );
  if (merged) turn.extracted = merged;
}

/**
 * Throwaway copy of the case carrying the turn's facts, so every part of the turn
 * judges the draft against the same state. Never persisted — a rejected draft
 * leaves no trace on the real case.
 */
export function caseForTurn(
  turn: TurnFacts,
  diagnosticCase: DiagnosticCase,
): DiagnosticCase {
  const extracted = turn.extracted ?? diagnosticCase.extracted;
  if (!extracted) return diagnosticCase;
  return { ...diagnosticCase, extracted };
}

/** Persist case facts — only once the turn is accepted. Never persist technicianOutcome. */
export function persistSemanticUpdate(
  diagnosticCase: DiagnosticCase,
  turn: TurnFacts,
): void {
  if (turn.extracted) diagnosticCase.extracted = turn.extracted;
}
