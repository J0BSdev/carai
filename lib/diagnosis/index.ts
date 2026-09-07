import { MockDiagnosticEngine, type DiagnosticEngine } from "./engine";

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
  LlmDiagnosticEngine,
  MockDiagnosticEngine,
  type DiagnosticEngine,
} from "./engine";

export {
  NoopWebSearchTool,
  type WebSearchResult,
  type WebSearchTool,
} from "./web-search";

/**
 * Returns the active diagnostic engine.
 * Today: always mock so the frontend → backend → frontend loop works without AI.
 * Later: if process.env.AI_API_KEY is set, return LlmDiagnosticEngine
 * (with optional WebSearchTool for SEARCH_WEB).
 */
export function getDiagnosticEngine(): DiagnosticEngine {
  // const apiKey = process.env.AI_API_KEY?.trim();
  // if (apiKey) return new LlmDiagnosticEngine(/* provider, new RealWebSearchTool() */);
  return new MockDiagnosticEngine();
}
