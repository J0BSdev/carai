import { ObservationConflictError } from "./errors";
import {
  assertUniqueObservations,
  parseStoredObservation,
} from "./observation";
import type {
  AiActionType,
  DiagnosisCertainty,
  DiagnosticCase,
  DiagnosticStep,
  ExtractedCaseFacts,
  Hypothesis,
  HypothesisStatus,
  VehicleInfo,
} from "./types";

const ACTIONS = ["ASK", "TEST", "FINISH"] as const;
const CERTAINTIES = [
  "SUSPECTED",
  "LIKELY",
  "HIGH_CONFIDENCE",
  "CONFIRMED",
] as const;
const HYPOTHESIS_STATUSES = [
  "plausible",
  "supported",
  "weakened",
  "ruled_out",
] as const;

function invalid(): never {
  throw new Error("case nije valjan");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function reqString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid();
  return value.trim();
}

function optString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim()) invalid();
  return value.trim();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid();
  return value as T;
}

function stringList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) invalid();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") invalid();
    const text = item.trim();
    if (text) out.push(text);
  }
  return out.length ? out : undefined;
}

function parseVehicle(value: unknown): VehicleInfo | undefined {
  if (value == null) return undefined;
  const raw = asObject(value);
  const vehicle: VehicleInfo = {};
  const make = optString(raw.make);
  const model = optString(raw.model);
  const engine = optString(raw.engine);
  if (make) vehicle.make = make;
  if (model) vehicle.model = model;
  if (engine) vehicle.engine = engine;
  if (raw.year != null) {
    if (
      typeof raw.year !== "number" ||
      !Number.isInteger(raw.year) ||
      raw.year < 1900 ||
      raw.year > 2100
    ) {
      invalid();
    }
    vehicle.year = raw.year;
  }
  if (raw.mileage != null) {
    if (typeof raw.mileage !== "number" || !Number.isFinite(raw.mileage)) invalid();
    vehicle.mileage = Math.round(raw.mileage);
  }
  return Object.keys(vehicle).length ? vehicle : undefined;
}

function parseExtracted(value: unknown): ExtractedCaseFacts | undefined {
  if (value == null) return undefined;
  const raw = asObject(value);
  const extracted: ExtractedCaseFacts = {};
  const vehicle = parseVehicle(raw.vehicle);
  if (vehicle) extracted.vehicle = vehicle;
  const symptoms = stringList(raw.symptoms);
  const dtcs = stringList(raw.dtcs);
  const measurements = stringList(raw.measurements);
  if (symptoms) extracted.symptoms = symptoms;
  if (dtcs) extracted.dtcs = dtcs;
  if (measurements) extracted.measurements = measurements;
  return extracted;
}

function parseHypotheses(value: unknown): Hypothesis[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) invalid();
  const parsed: Hypothesis[] = [];
  for (const item of value) {
    const raw = asObject(item);
    const label = reqString(raw.label);
    const status = oneOf(raw.status, HYPOTHESIS_STATUSES) as HypothesisStatus;
    const row: Hypothesis = { label, status };
    if (raw.confidence != null) {
      if (
        typeof raw.confidence !== "number" ||
        !Number.isFinite(raw.confidence) ||
        raw.confidence < 0 ||
        raw.confidence > 100
      ) {
        invalid();
      }
      row.confidence = Math.round(raw.confidence);
    }
    parsed.push(row);
  }
  return parsed.length ? parsed : undefined;
}

function parseStoredStep(value: unknown): DiagnosticStep {
  const raw = asObject(value);
  const actionType = oneOf(raw.actionType, ACTIONS) as AiActionType;
  const step: DiagnosticStep = {
    id: reqString(raw.id),
    actionType,
    content: reqString(raw.content),
    rationale: reqString(raw.rationale),
  };
  if (actionType === "ASK") {
    for (const key of ["expectedResultHint", "testGuide", "confirmedFault", "diagnosisCertainty"]) {
      if (raw[key] != null) invalid();
    }
  }
  if (actionType === "TEST") {
    for (const key of ["confirmedFault", "diagnosisCertainty"]) {
      if (raw[key] != null) invalid();
    }
    const expectedResultHint = optString(raw.expectedResultHint);
    if (!expectedResultHint) invalid();
    step.expectedResultHint = expectedResultHint;
    const testGuide = optString(raw.testGuide);
    if (testGuide) step.testGuide = testGuide;
  }
  if (actionType === "FINISH") {
    for (const key of ["expectedResultHint", "testGuide"]) {
      if (raw[key] != null) invalid();
    }
    const confirmedFault = optString(raw.confirmedFault);
    if (!confirmedFault) invalid();
    step.confirmedFault = confirmedFault;
    step.diagnosisCertainty = oneOf(
      raw.diagnosisCertainty,
      CERTAINTIES,
    ) as DiagnosisCertainty;
  }
  const hypotheses = parseHypotheses(raw.hypotheses);
  if (hypotheses) step.hypotheses = hypotheses;
  return step;
}

/** Client-carried case. Unknown nested fields are dropped. Corrupt shape fails. */
export function parseDiagnosticCase(value: unknown): DiagnosticCase {
  const raw = asObject(value);
  const steps = Array.isArray(raw.steps) ? raw.steps.map(parseStoredStep) : invalid();
  if (steps.length === 0) invalid();
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) invalid();
    ids.add(step.id);
  }

  let observations;
  try {
    const parsed = Array.isArray(raw.observations)
      ? raw.observations.map(parseStoredObservation)
      : invalid();
    for (const obs of parsed) {
      if (!ids.has(obs.stepId)) invalid();
    }
    observations = assertUniqueObservations(parsed);
  } catch (error) {
    if (error instanceof ObservationConflictError) throw error;
    invalid();
  }

  const diagnosticCase: DiagnosticCase = {
    id: reqString(raw.id),
    createdAt: reqString(raw.createdAt),
    problemText: reqString(raw.problemText),
    observations,
    steps,
  };
  const extracted = parseExtracted(raw.extracted);
  if (extracted) diagnosticCase.extracted = extracted;
  if (raw.strongVerifierUsed != null) {
    if (typeof raw.strongVerifierUsed !== "boolean") invalid();
    diagnosticCase.strongVerifierUsed = raw.strongVerifierUsed;
  }
  return diagnosticCase;
}
