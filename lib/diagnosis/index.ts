import { MockDiagnosticEngine, type DiagnosticEngine } from "./engine";

export type {
  CaseStatus,
  DiagnoseAction,
  DiagnoseRequest,
  DiagnoseResponse,
  DiagnosticCase,
  DiagnosticStep,
  Observation,
} from "./types";

export {
  LlmDiagnosticEngine,
  MockDiagnosticEngine,
  type DiagnosticEngine,
} from "./engine";

/**
 * Returns the active diagnostic engine.
 * Today: always mock so the frontend → backend → frontend loop works without AI.
 * Later: if process.env.AI_API_KEY is set, return a wired LlmDiagnosticEngine
 * (and optionally keep web-search tools behind the same interface).
 */
export function getDiagnosticEngine(): DiagnosticEngine {
  // const apiKey = process.env.AI_API_KEY?.trim();
  // if (apiKey) return new LlmDiagnosticEngine(/* provider from apiKey */);
  return new MockDiagnosticEngine();
}
