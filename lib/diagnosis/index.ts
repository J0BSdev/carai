import { hasLlmConfigured } from "./config";
import { MockDiagnosticEngine, type DiagnosticEngine } from "./engine";
import { LlmDiagnosticEngine } from "./llm-engine";

export type {
  AiActionType,
  CaseStatus,
  DiagnoseAction,
  DiagnoseRequest,
  DiagnoseResponse,
  DiagnosticCase,
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

export { type DiagnosticEngine } from "./engine";

export { DIAGNOSTIC_UNAVAILABLE_MESSAGE } from "./errors";

/**
 * 3-tier LLM when both CLAUDE_API_KEY and OPENAI_API_KEY are set; otherwise mock.
 */
export function getDiagnosticEngine(): DiagnosticEngine {
  if (hasLlmConfigured()) {
    return new LlmDiagnosticEngine();
  }
  return new MockDiagnosticEngine();
}
