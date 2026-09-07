export type CaseStatus = "active" | "completed";

export interface DiagnosticStep {
  id: string;
  instruction: string;
  rationale?: string;
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
  observations: Observation[];
  steps: DiagnosticStep[];
  status: CaseStatus;
}

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
  nextStep: DiagnosticStep | null;
  message?: string;
}
