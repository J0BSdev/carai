/** Neutral, retryable message for the mechanic — never leaks internal detail. */
export const DIAGNOSTIC_UNAVAILABLE_MESSAGE =
  "Trenutno nije moguće predložiti sljedeći korak. Pokušaj ponovno ili dopuni zadnji nalaz.";

/** Neutral conflict message — never includes stepId or stored result text. */
export const OBSERVATION_CONFLICT_MESSAGE =
  "Za ovaj korak već postoji drugačiji rezultat. Izmjena nije podržana.";

/**
 * Internal diagnostic pipeline failure. The message carries technical detail for
 * server logs and telemetry only; clients must be shown
 * DIAGNOSTIC_UNAVAILABLE_MESSAGE instead.
 */
export class DiagnosticPipelineError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DiagnosticPipelineError";
  }
}

/**
 * Current step already has a different observation. Detail is for server logs
 * only; clients must be shown OBSERVATION_CONFLICT_MESSAGE.
 */
export class ObservationConflictError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ObservationConflictError";
  }
}

/**
 * Observation kind is not legal for the current step.
 * Message is safe to show to the client. No AI call and no observation write.
 */
export class InvalidObservationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "InvalidObservationError";
  }
}

/** Diagnostic model JSON does not match the draft contract. Safe to show the model on retry. */
export class DraftShapeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DraftShapeError";
  }
}
