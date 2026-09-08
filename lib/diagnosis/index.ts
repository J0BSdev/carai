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

export {
  MockDiagnosticEngine,
  type DiagnosticEngine,
} from "./engine";

export { LlmDiagnosticEngine } from "./llm-engine";

export {
  NoopWebSearchTool,
  type WebSearchResult,
  type WebSearchTool,
} from "./web-search";

export {
  getClaudeApiKey,
  getDiagnosticModel,
  getOpenAiApiKey,
  getVerifierModel,
  hasLlmConfigured,
} from "./config";

/**
 * Dual LLM when both CLAUDE_API_KEY and OPENAI_API_KEY are set; otherwise mock.
 */
export function getDiagnosticEngine(): DiagnosticEngine {
  if (hasLlmConfigured()) {
    return new LlmDiagnosticEngine();
  }
  return new MockDiagnosticEngine();
}
