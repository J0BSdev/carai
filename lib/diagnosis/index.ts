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
  ExtractedCaseFacts,
  Hypothesis,
  Observation,
  RecommendedTest,
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

function hasOpenAiKey(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY?.trim() || process.env.AI_API_KEY?.trim(),
  );
}

/**
 * LLM when OPENAI_API_KEY or AI_API_KEY is set; otherwise mock for local UI testing.
 */
export function getDiagnosticEngine(): DiagnosticEngine {
  if (hasOpenAiKey()) {
    return new LlmDiagnosticEngine();
  }
  return new MockDiagnosticEngine();
}
