import { InvalidObservationError, ObservationConflictError } from "./errors";
import type { AiActionType, Observation, ObservationInput } from "./types";

const ALLOWED_ON: Record<Observation["kind"], readonly AiActionType[]> = {
  RESULT: ["ASK", "TEST"],
  SKIP: ["ASK", "TEST"],
  CANNOT_PERFORM: ["TEST"],
  REJECT_DIAGNOSIS: ["FINISH"],
  CONTINUE_AFTER_FINISH: ["FINISH"],
};

const PAYLOAD_KEYS: Record<Observation["kind"], readonly string[]> = {
  RESULT: ["kind", "text"],
  SKIP: ["kind"],
  CANNOT_PERFORM: ["kind", "reason"],
  REJECT_DIAGNOSIS: ["kind"],
  CONTINUE_AFTER_FINISH: ["kind"],
};

export function assertObservationAllowed(
  kind: Observation["kind"],
  actionType: AiActionType,
): void {
  if (!ALLOWED_ON[kind].includes(actionType)) {
    throw new InvalidObservationError(
      `observation ${kind} nije dozvoljen za actionType ${actionType}`,
    );
  }
}

/**
 * One observation per step.
 * Identical duplicates collapse. A different payload on the same step is corrupt.
 */
export function assertUniqueObservations(observations: Observation[]): Observation[] {
  const firstByStepId = new Map<string, Observation>();
  const out: Observation[] = [];
  for (const obs of observations) {
    const first = firstByStepId.get(obs.stepId);
    if (!first) {
      firstByStepId.set(obs.stepId, obs);
      out.push(obs);
      continue;
    }
    if (!sameObservation(first, obs)) {
      throw new ObservationConflictError(
        `Conflicting observations for step ${obs.stepId}`,
      );
    }
  }
  return out;
}

/** Same step, kind, and payload. recordedAt is not part of identity. */
export function sameObservation(a: Observation, b: Observation): boolean {
  if (a.stepId !== b.stepId || a.kind !== b.kind) return false;
  if (a.kind === "RESULT" && b.kind === "RESULT") return a.text === b.text;
  if (a.kind === "CANNOT_PERFORM" && b.kind === "CANNOT_PERFORM") {
    return a.reason === b.reason;
  }
  return true;
}

export function stampObservation(
  stepId: string,
  input: ObservationInput,
): Observation {
  const recordedAt = new Date().toISOString();
  switch (input.kind) {
    case "RESULT":
      return { kind: "RESULT", stepId, text: input.text, recordedAt };
    case "CANNOT_PERFORM":
      return input.reason
        ? { kind: "CANNOT_PERFORM", stepId, reason: input.reason, recordedAt }
        : { kind: "CANNOT_PERFORM", stepId, recordedAt };
    case "SKIP":
      return { kind: "SKIP", stepId, recordedAt };
    case "REJECT_DIAGNOSIS":
      return { kind: "REJECT_DIAGNOSIS", stepId, recordedAt };
    case "CONTINUE_AFTER_FINISH":
      return { kind: "CONTINUE_AFTER_FINISH", stepId, recordedAt };
  }
}

/** Mechanic prose. Structured kinds have none. */
export function observationResultText(
  obs: Observation | undefined,
): string | null {
  return obs?.kind === "RESULT" ? obs.text : null;
}

function parsePayload(raw: Record<string, unknown>): ObservationInput {
  const kind = raw.kind;
  if (
    kind !== "RESULT" &&
    kind !== "SKIP" &&
    kind !== "CANNOT_PERFORM" &&
    kind !== "REJECT_DIAGNOSIS" &&
    kind !== "CONTINUE_AFTER_FINISH"
  ) {
    throw new Error("observation.kind nije valjan");
  }

  for (const key of Object.keys(raw)) {
    if (!PAYLOAD_KEYS[kind].includes(key)) {
      throw new Error(`observation.${key} nije dozvoljen`);
    }
  }

  switch (kind) {
    case "RESULT": {
      if (typeof raw.text !== "string" || !raw.text.trim()) {
        throw new Error("observation.text je obavezan za RESULT");
      }
      return { kind: "RESULT", text: raw.text.trim() };
    }
    case "CANNOT_PERFORM": {
      if (raw.reason == null) return { kind: "CANNOT_PERFORM" };
      if (typeof raw.reason !== "string") {
        throw new Error("observation.reason mora biti string");
      }
      const reason = raw.reason.trim();
      return reason
        ? { kind: "CANNOT_PERFORM", reason }
        : { kind: "CANNOT_PERFORM" };
    }
    default:
      return { kind };
  }
}

export function parseObservationInput(value: unknown): ObservationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("observation mora biti objekt");
  }
  return parsePayload(value as Record<string, unknown>);
}

export function parseStoredObservation(value: unknown): Observation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("observation mora biti objekt");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.stepId !== "string" || !raw.stepId) {
    throw new Error("observation.stepId je obavezan");
  }
  if (typeof raw.recordedAt !== "string" || !raw.recordedAt) {
    throw new Error("observation.recordedAt je obavezan");
  }
  const payload: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (key === "stepId" || key === "recordedAt") continue;
    payload[key] = field;
  }
  return {
    ...parsePayload(payload),
    stepId: raw.stepId,
    recordedAt: raw.recordedAt,
  };
}
