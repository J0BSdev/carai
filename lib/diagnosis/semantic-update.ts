import type { LlmStepPayload } from "./providers";
import type {
  DiagnosticCase,
  ExtractedCaseFacts,
  TechnicianOutcome,
  VehicleInfo,
} from "./types";

/** Turn-scoped facts. technicianOutcome is never written onto the case. */
export type TurnFacts = {
  allowTechnicianOutcome: boolean;
  technicianOutcome: TechnicianOutcome | null;
  extracted: ExtractedCaseFacts | null;
};

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Merge an already-parsed semanticUpdate. Returns null when nothing changes.
 * The draft parser already checked types.
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
  if (rawVehicle) {
    const patch: VehicleInfo = { ...vehicle };
    let vehicleChanged = false;
    const setField = <K extends keyof VehicleInfo>(key: K, value: VehicleInfo[K]) => {
      if (patch[key] === value) return;
      patch[key] = value;
      vehicleChanged = true;
    };
    if (rawVehicle.make) setField("make", rawVehicle.make);
    if (rawVehicle.model) setField("model", rawVehicle.model);
    if (rawVehicle.year != null) setField("year", rawVehicle.year);
    if (rawVehicle.engine) setField("engine", rawVehicle.engine);
    if (rawVehicle.mileage != null) setField("mileage", rawVehicle.mileage);
    if (vehicleChanged) {
      vehicle = patch;
      changed = true;
    }
  }

  const addList = (
    current: string[],
    incoming: string[] | undefined,
  ): string[] => {
    if (!incoming?.length) return current;
    const merged = dedupe([...current, ...incoming]);
    if (merged.length !== current.length) changed = true;
    return merged;
  };

  symptoms = addList(symptoms, update.symptomsAdd);
  dtcs = addList(dtcs, update.dtcsAdd);
  measurements = addList(measurements, update.measurementsAdd);

  if (update.symptomsRemove?.length) {
    const removeKeys = new Set(update.symptomsRemove.map((s) => s.toLowerCase()));
    const next = symptoms.filter((s) => !removeKeys.has(s.toLowerCase()));
    if (next.length !== symptoms.length) {
      symptoms = next;
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

/** Fold this draft's semanticUpdate into the turn. Verifier drafts never reach here. */
export function recordSemanticUpdate(
  turn: TurnFacts,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): void {
  const update = draft.semanticUpdate;
  turn.technicianOutcome = turn.allowTechnicianOutcome
    ? (update?.technicianOutcome ?? null)
    : null;
  if (!update) return;
  const merged = mergeSemanticUpdate(
    turn.extracted ?? diagnosticCase.extracted ?? {},
    update,
  );
  if (merged) turn.extracted = merged;
}

/** Throwaway case copy so the rest of the turn sees the same facts. */
export function caseForTurn(
  turn: TurnFacts,
  diagnosticCase: DiagnosticCase,
): DiagnosticCase {
  const extracted = turn.extracted ?? diagnosticCase.extracted;
  if (!extracted) return diagnosticCase;
  return { ...diagnosticCase, extracted };
}

/** Persist case facts once the turn is accepted. Never persist technicianOutcome. */
export function persistSemanticUpdate(
  diagnosticCase: DiagnosticCase,
  turn: TurnFacts,
): void {
  if (turn.extracted) diagnosticCase.extracted = turn.extracted;
}
