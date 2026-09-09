export type CaseStatus = "active" | "completed";

/** Primary AI action for one diagnostic turn (product spec). */
export type AiActionType = "ASK" | "TEST" | "SEARCH_WEB" | "FINISH";

export type HypothesisStatus =
  | "plausible"
  | "weakened"
  | "ruled_out"
  | "supported";

/** Overall diagnosis certainty for FINISH (stricter than hypothesis ranking). */
export type DiagnosisCertainty =
  | "SUSPECTED"
  | "LIKELY"
  | "HIGH_CONFIDENCE"
  | "CONFIRMED";

export interface RejectedDiagnosis {
  diagnosis: string;
  rejectedAtStep: string;
  reason: "technician_rejected" | string;
  rejectedAt: string;
}

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
  observations?: string[];
  measurements?: string[];
}

export interface Hypothesis {
  label: string;
  status: HypothesisStatus;
  note?: string;
  /** Evidence-based ranking estimate (0–100), not statistical probability. */
  confidence?: number | null;
  supportingEvidence?: string[];
  contradictingEvidence?: string[];
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
  /** Evidence-based ranking 0–100 for the leading diagnosis (FINISH). */
  diagnosisConfidence?: number | null;
  /** Strict certainty ladder for FINISH. CONFIRMED is rare. */
  diagnosisCertainty?: DiagnosisCertainty;
  insufficientEvidence?: boolean;
  /** What the mechanic should record when answering. */
  expectedResultHint?: string;
}

export interface Observation {
  stepId: string;
  resultText: string;
  recordedAt: string;
}

export type SpecVerificationStatus = "VERIFIED" | "UNVERIFIED";

/** Provenance of a technical claim/spec — required honesty label for AI claims. */
export type TechnicalSourceType =
  | "VERIFIED_OEM"
  | "VERIFIED_TECHNICAL"
  | "GENERAL_PRINCIPLE"
  | "MODEL_KNOWLEDGE"
  | "UNKNOWN";

/** Locked vehicle-specific reference specification claim. */
export interface TechnicalSpecClaim {
  parameterKey: string;
  label: string;
  valueText: string;
  unit: string;
  low: number | null;
  high: number | null;
  condition: string | null;
  status: SpecVerificationStatus;
  /** Honesty label; VERIFIED_* only when backed by verifiedTechnicalSpecs. */
  sourceType?: TechnicalSourceType;
  source?: string;
  vehicleEngineMatch?: string;
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
  /**
   * Locked technical reference specs for this case.
   * VERIFIED entries may only come from an external source mechanism (not the model).
   */
  verifiedTechnicalSpecs?: TechnicalSpecClaim[];
  /** Previously stated reference claims (locked for consistency; still UNVERIFIED unless also verified). */
  technicalSpecClaims?: TechnicalSpecClaim[];
  /** Diagnoses rejected by the technician ("Dijagnoza ne izgleda točno"). */
  rejectedDiagnoses?: RejectedDiagnosis[];
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
