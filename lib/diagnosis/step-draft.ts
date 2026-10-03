import { DraftShapeError } from "./errors";
import type { LlmStepPayload, SemanticUpdate } from "./providers";
import type {
  AiActionType,
  DiagnosisCertainty,
  DiagnosticStep,
  Hypothesis,
  HypothesisStatus,
  TechnicalSourceType,
  TechnicianOutcome,
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
const SOURCE_TYPES = [
  "VERIFIED_OEM",
  "VERIFIED_TECHNICAL",
  "GENERAL_PRINCIPLE",
  "MODEL_KNOWLEDGE",
  "UNKNOWN",
] as const;

const TOP_KEYS = new Set([
  "actionType",
  "content",
  "rationale",
  "expectedResultHint",
  "confirmedFault",
  "diagnosisCertainty",
  "semanticUpdate",
  "technicalClaims",
  "hypotheses",
  "testGuide",
]);

function fail(message: string): never {
  throw new DraftShapeError(message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} mora biti objekt.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(`${label}: nepoznato polje ${key}.`);
  }
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) {
    fail(`DRAFT: ${key} je obavezan string.`);
  }
  return value.trim();
}

function optString(value: unknown, key: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    fail(`DRAFT: ${key} mora biti neprazan string.`);
  }
  return value.trim();
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`DRAFT: ${key} mora biti ${allowed.join("|")}.`);
  }
  return value as T;
}

function stringList(value: unknown, key: string, map?: (item: string) => string): string[] {
  if (!Array.isArray(value)) fail(`DRAFT: ${key} mora biti niz stringova.`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") fail(`DRAFT: ${key} mora biti niz stringova.`);
    const text = (map ? map(item) : item).trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function parseYear(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2100) {
    return value;
  }
  if (typeof value === "string" && /^(19|20)\d{2}$/.test(value.trim())) {
    return Number(value.trim());
  }
  fail("DRAFT: semanticUpdate.vehicle.year mora biti godina.");
}

function parseVehicle(
  value: unknown,
): NonNullable<SemanticUpdate["vehicle"]> | undefined {
  if (value == null) return undefined;
  const raw = asObject(value, "DRAFT: semanticUpdate.vehicle");
  rejectUnknown(
    raw,
    new Set(["make", "model", "year", "engine", "mileage"]),
    "DRAFT: semanticUpdate.vehicle",
  );
  const vehicle: NonNullable<SemanticUpdate["vehicle"]> = {};
  const make = optString(raw.make, "vehicle.make");
  const model = optString(raw.model, "vehicle.model");
  const engine = optString(raw.engine, "vehicle.engine");
  const year = parseYear(raw.year);
  if (make) vehicle.make = make;
  if (model) vehicle.model = model;
  if (engine) vehicle.engine = engine;
  if (year != null) vehicle.year = year;
  if (raw.mileage != null) {
    if (typeof raw.mileage !== "number" || !Number.isFinite(raw.mileage)) {
      fail("DRAFT: semanticUpdate.vehicle.mileage mora biti broj.");
    }
    vehicle.mileage = Math.round(raw.mileage);
  }
  return Object.keys(vehicle).length ? vehicle : undefined;
}

function parseTechnicianOutcome(value: unknown): TechnicianOutcome | undefined {
  if (value == null) return undefined;
  const raw = asObject(value, "DRAFT: technicianOutcome");
  rejectUnknown(raw, new Set(["status"]), "DRAFT: technicianOutcome");
  const status = oneOf(
    raw.status,
    ["FAULT_CONFIRMED", "REPAIR_CONFIRMED"] as const,
    "technicianOutcome.status",
  );
  return { status };
}

function parseSemanticUpdate(value: unknown): SemanticUpdate | undefined {
  if (value == null) return undefined;
  const raw = asObject(value, "DRAFT: semanticUpdate");
  rejectUnknown(
    raw,
    new Set([
      "vehicle",
      "symptomsAdd",
      "symptomsRemove",
      "dtcsAdd",
      "measurementsAdd",
      "technicianOutcome",
    ]),
    "DRAFT: semanticUpdate",
  );
  const update: SemanticUpdate = {};
  const vehicle = parseVehicle(raw.vehicle);
  if (vehicle) update.vehicle = vehicle;
  if (raw.symptomsAdd != null) {
    update.symptomsAdd = stringList(raw.symptomsAdd, "symptomsAdd");
  }
  if (raw.symptomsRemove != null) {
    update.symptomsRemove = stringList(raw.symptomsRemove, "symptomsRemove");
  }
  if (raw.dtcsAdd != null) {
    const codes = stringList(raw.dtcsAdd, "dtcsAdd", (item) =>
      item.replace(/\s+/g, " ").toUpperCase(),
    );
    if (codes.some((code) => code.length > 24)) {
      fail("DRAFT: dtcsAdd stavka je predugačka.");
    }
    update.dtcsAdd = codes;
  }
  if (raw.measurementsAdd != null) {
    if (!Array.isArray(raw.measurementsAdd)) {
      fail("DRAFT: measurementsAdd mora biti niz.");
    }
    const measurements: string[] = [];
    for (const item of raw.measurementsAdd) {
      const row = asObject(item, "DRAFT: measurementsAdd");
      rejectUnknown(row, new Set(["raw"]), "DRAFT: measurementsAdd");
      const text = optString(row.raw, "measurementsAdd.raw");
      if (!text || text.length > 120) {
        fail("DRAFT: measurementsAdd.raw mora biti kratak string.");
      }
      measurements.push(text);
    }
    update.measurementsAdd = measurements;
  }
  const outcome = parseTechnicianOutcome(raw.technicianOutcome);
  if (outcome) update.technicianOutcome = outcome;
  return Object.keys(update).length ? update : undefined;
}

function parseHypotheses(value: unknown): Hypothesis[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) fail("DRAFT: hypotheses mora biti niz.");
  const parsed: Hypothesis[] = [];
  for (const item of value) {
    const raw = asObject(item, "DRAFT: hypothesis");
    rejectUnknown(
      raw,
      new Set(["label", "status", "confidence"]),
      "DRAFT: hypothesis",
    );
    const label = reqString(raw, "label");
    const status = oneOf(
      raw.status,
      HYPOTHESIS_STATUSES,
      "hypothesis.status",
    ) as HypothesisStatus;
    const row: Hypothesis = { label, status };
    if (raw.confidence != null) {
      if (
        typeof raw.confidence !== "number" ||
        !Number.isFinite(raw.confidence) ||
        raw.confidence < 0 ||
        raw.confidence > 100
      ) {
        fail("DRAFT: hypothesis.confidence mora biti broj 0–100.");
      }
      row.confidence = Math.round(raw.confidence);
    }
    parsed.push(row);
  }
  return parsed.length ? parsed : undefined;
}

function parseTechnicalClaims(
  value: unknown,
): LlmStepPayload["technicalClaims"] {
  if (value == null) return undefined;
  if (!Array.isArray(value)) fail("DRAFT: technicalClaims mora biti niz.");
  const parsed: NonNullable<LlmStepPayload["technicalClaims"]> = [];
  for (const item of value) {
    const raw = asObject(item, "DRAFT: technicalClaims");
    rejectUnknown(
      raw,
      new Set(["claim", "valueText", "sourceType", "vehicleSpecific"]),
      "DRAFT: technicalClaims",
    );
    const claim = reqString(raw, "claim");
    const sourceType = oneOf(
      raw.sourceType,
      SOURCE_TYPES,
      "technicalClaims.sourceType",
    ) as TechnicalSourceType;
    const row: NonNullable<LlmStepPayload["technicalClaims"]>[number] = {
      claim,
      sourceType,
    };
    const valueText = optString(raw.valueText, "technicalClaims.valueText");
    if (valueText) row.valueText = valueText;
    if (raw.vehicleSpecific != null) {
      if (typeof raw.vehicleSpecific !== "boolean") {
        fail("DRAFT: technicalClaims.vehicleSpecific mora biti boolean.");
      }
      row.vehicleSpecific = raw.vehicleSpecific;
    }
    parsed.push(row);
  }
  return parsed.length ? parsed : undefined;
}

function parseDraftObject(value: unknown): LlmStepPayload {
  const raw = asObject(value, "DRAFT");
  rejectUnknown(raw, TOP_KEYS, "DRAFT");
  const actionType = oneOf(raw.actionType, ACTIONS, "actionType") as AiActionType;
  const content = reqString(raw, "content");
  const rationale = reqString(raw, "rationale");

  if (actionType === "ASK") {
    for (const key of ["expectedResultHint", "confirmedFault", "diagnosisCertainty", "testGuide"]) {
      if (raw[key] != null) fail(`DRAFT: ${key} nije dozvoljen za ASK.`);
    }
  }
  if (actionType === "TEST") {
    for (const key of ["confirmedFault", "diagnosisCertainty"]) {
      if (raw[key] != null) fail(`DRAFT: ${key} nije dozvoljen za TEST.`);
    }
  }
  if (actionType === "FINISH") {
    for (const key of ["expectedResultHint", "testGuide"]) {
      if (raw[key] != null) fail(`DRAFT: ${key} nije dozvoljen za FINISH.`);
    }
  }

  const draft: LlmStepPayload = { actionType, content, rationale };
  if (actionType === "TEST") {
    draft.expectedResultHint = optString(raw.expectedResultHint, "expectedResultHint");
    if (!draft.expectedResultHint) {
      fail("DRAFT: TEST zahtijeva expectedResultHint.");
    }
    const testGuide = optString(raw.testGuide, "testGuide");
    if (testGuide) draft.testGuide = testGuide;
  }
  if (actionType === "FINISH") {
    draft.confirmedFault = optString(raw.confirmedFault, "confirmedFault");
    if (!draft.confirmedFault) fail("DRAFT: FINISH zahtijeva confirmedFault.");
    draft.diagnosisCertainty = oneOf(
      raw.diagnosisCertainty,
      CERTAINTIES,
      "diagnosisCertainty",
    ) as DiagnosisCertainty;
  }

  const semanticUpdate = parseSemanticUpdate(raw.semanticUpdate);
  if (semanticUpdate) draft.semanticUpdate = semanticUpdate;
  const hypotheses = parseHypotheses(raw.hypotheses);
  if (hypotheses) draft.hypotheses = hypotheses;
  const technicalClaims = parseTechnicalClaims(raw.technicalClaims);
  if (technicalClaims) draft.technicalClaims = technicalClaims;
  return draft;
}

/** Strict diagnostic draft. Invalid shape throws DraftShapeError. */
export function parseDiagnosticDraft(raw: string): LlmStepPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("DRAFT nije valjani JSON.");
  }
  return parseDraftObject(value);
}

export function toDiagnosticStep(
  payload: LlmStepPayload,
  stepId: string,
): DiagnosticStep {
  return {
    id: stepId,
    actionType: payload.actionType,
    content: payload.content,
    rationale: payload.rationale,
    expectedResultHint: payload.expectedResultHint,
    confirmedFault: payload.confirmedFault,
    diagnosisCertainty: payload.diagnosisCertainty,
    hypotheses: payload.hypotheses,
    testGuide: payload.testGuide,
  };
}
