import type { DiagnosticEngine } from "./types";
import { LlmDiagnosticEngine } from "./llm-engine";

export type {
  AiActionType,
  CaseStatus,
  DiagnoseAction,
  DiagnoseRequest,
  DiagnoseResponse,
  DiagnosticCase,
  DiagnosticEngine,
  DiagnosticStep,
  DiagnosisCertainty,
  ExtractedCaseFacts,
  Hypothesis,
  HypothesisStatus,
  Observation,
  RecommendedTest,
  RejectedDiagnosis,
  SourceRef,
  VehicleInfo,
} from "./types";

export { DIAGNOSTIC_UNAVAILABLE_MESSAGE } from "./errors";

/** Claude diagnostician + OpenAI verifier (requires CLAUDE_API_KEY and OPENAI_API_KEY). */
export function getDiagnosticEngine(): DiagnosticEngine {
  return new LlmDiagnosticEngine();
}
