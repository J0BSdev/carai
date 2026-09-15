/** Neutral, retryable message for the mechanic — never leaks internal detail. */
export const DIAGNOSTIC_UNAVAILABLE_MESSAGE =
  "Trenutno nije moguće predložiti sljedeći korak. Pokušaj ponovno ili dopuni zadnji nalaz.";

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
