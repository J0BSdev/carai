export type CaseStatus = "active" | "completed";

/** Primary AI action for one diagnostic turn (product spec). */
export type AiActionType = "ASK" | "TEST" | "SEARCH_WEB" | "FINISH";

export type HypothesisStatus =
  | "plausible"
  | "weakened"
  | "ruled_out"
  | "supported";

export type SourceAuthority = "oem" | "tsb" | "manual" | "forum" | "other";

export interface VehicleInfo {
  make?: string;
  model?: string;
  year?: number;
  engine?: string;
  mileage?: number;
}

export interface ExtractedCaseFacts {
  vehicle?: VehicleInfo;
  symptoms?: string[];
  dtcs?: string[];
  priorTests?: string[];
}

export interface Hypothesis {
  label: string;
  status: HypothesisStatus;
  note?: string;
}

export interface SourceRef {
  url: string;
  title: string;
  authority: SourceAuthority;
}

export interface RecommendedTest {
  name: string;
  howTo?: string;
  whatToRecord?: string;
  specs?: {
    value: string;
    verified: boolean;
    source?: SourceRef;
  };
}

/**
 * One AI turn: exactly one primary action (ASK | TEST | SEARCH_WEB | FINISH).
 * SEARCH_WEB is reserved for a later milestone; mock never emits it.
 */
export interface DiagnosticStep {
  id: string;
  actionType: AiActionType;
  /** Question, test instruction, or finish summary. */
  content: string;
  rationale: string;
  facts?: string[];
  evidence?: string[];
  hypotheses?: Hypothesis[];
  recommendedTest?: RecommendedTest;
  searchQuery?: string;
  sources?: SourceRef[];
  confirmedFault?: string;
  confidence?: "low" | "medium" | "high";
  insufficientEvidence?: boolean;
  /** What the mechanic should record when answering. */
  expectedResultHint?: string;
}

export interface Observation {
  stepId: string;
  resultText: string;
  recordedAt: string;
}

export interface DiagnosticCase {
  id: string;
  createdAt: string;
  problemText: string;
  /** Merged facts extracted from NL + mechanic answers (mock may fill lightly). */
  extracted?: ExtractedCaseFacts;
  observations: Observation[];
  steps: DiagnosticStep[];
  status: CaseStatus;
  confirmedFault?: string;
}

/** HTTP API body action (start/continue case), not AI actionType. */
export type DiagnoseAction = "start" | "continue";

export interface DiagnoseRequest {
  action: DiagnoseAction;
  problemText?: string;
  case?: DiagnosticCase;
  observation?: {
    resultText: string;
  };
}

export interface DiagnoseResponse {
  case: DiagnosticCase;
  /** Current open step; null when case is completed after FINISH. */
  nextStep: DiagnosticStep | null;
  message?: string;
}
