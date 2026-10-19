/** Primary AI action for one diagnostic turn (product spec). */
export type AiActionType = "ASK" | "TEST" | "FINISH";

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

export interface VehicleInfo {
  make?: string;
  model?: string;
  year?: number;
  engine?: string;
  mileage?: number;
}

/**
 * Mechanic confirmed a fault or a repair on this turn.
 * Omit the field when there is no confirmation. The fault text lives on the FINISH step.
 */
export type TechnicianOutcome =
  | { status: "FAULT_CONFIRMED" }
  | { status: "REPAIR_CONFIRMED" };

export interface ExtractedCaseFacts {
  vehicle?: VehicleInfo;
  symptoms?: string[];
  dtcs?: string[];
}

export interface Hypothesis {
  label: string;
  status: HypothesisStatus;
  /** Evidence-based ranking estimate (0–100), not statistical probability. */
  confidence?: number;
}

/** One AI turn: exactly one primary action (ASK | TEST | FINISH). */
export interface DiagnosticStep {
  id: string;
  actionType: AiActionType;
  /** Short heading for an ASK or TEST. Claude writes it; the backend does not derive it. */
  title?: string;
  /** Detailed question, test instruction, or finish summary. */
  content: string;
  rationale: string;
  hypotheses?: Hypothesis[];
  confirmedFault?: string;
  /** Strict certainty ladder for FINISH. Not CONFIRMED means evidence is still insufficient. */
  diagnosisCertainty?: DiagnosisCertainty;
  /** What the mechanic should record when answering. */
  expectedResultHint?: string;
  /** Optional short how-to for a non-routine TEST (UI guide). */
  testGuide?: string;
}

/** One recorded user action. Only RESULT carries mechanic prose. */
export type Observation =
  | {
      kind: "RESULT";
      stepId: string;
      /** Omitted when the turn result is only the attached photo. */
      text?: string;
      /** The photo bytes are not stored. True only when this result included one. */
      hasPhoto?: boolean;
      recordedAt: string;
    }
  | {
      kind: "SKIP";
      stepId: string;
      recordedAt: string;
    }
  | {
      kind: "CANNOT_PERFORM";
      stepId: string;
      reason?: string;
      recordedAt: string;
    }
  | {
      kind: "REJECT_DIAGNOSIS";
      stepId: string;
      recordedAt: string;
    }
  | {
      kind: "CONTINUE_AFTER_FINISH";
      stepId: string;
      recordedAt: string;
    };

/** Continue payload. Server stamps stepId and recordedAt. */
export type ObservationInput = {
  [K in Observation["kind"]]: Omit<
    Extract<Observation, { kind: K }>,
    "stepId" | "recordedAt"
  >;
}[Observation["kind"]];

/** Provenance label the model may attach to a technical claim. */
export type TechnicalSourceType =
  | "GENERAL_PRINCIPLE"
  | "MODEL_KNOWLEDGE"
  | "UNKNOWN";

/** Short hint from a past resolved case. Never treated as proof of the current fault. */
export interface PriorResolvedCaseHint {
  vehicle: string | null;
  problem: string | null;
  resolvedFault: string | null;
  source: "manual" | "carai";
  /** CONFIRMED | HIGH_CONFIDENCE | manual | unknown */
  certainty: string;
}

/** Server-attached prior hints for the current request prompt. Not trusted from the client. */
export interface PriorResolvedHints {
  fingerprint: string;
  items: PriorResolvedCaseHint[];
}

export interface DiagnosticCase {
  id: string;
  createdAt: string;
  problemText: string;
  /** Structured facts. Extracted by the diagnostic AI (semanticUpdate); backend only validates/merges. */
  extracted?: ExtractedCaseFacts;
  observations: Observation[];
  steps: DiagnosticStep[];
  /**
   * Strong verifier at most once per case. The client carries the case between
   * requests, so this flag cannot live only on the current turn.
   */
  strongVerifierUsed?: boolean;
  /**
   * Ephemeral prior-case hints for Claude (server-filled only). Not proof.
   * Client-supplied values are ignored. Stripped before DB save.
   */
  priorResolvedHints?: PriorResolvedHints;
}

/** HTTP API body action (start/continue case), not AI actionType. */
export type DiagnoseAction = "start" | "continue";

/** One photo for the current request. Never written onto DiagnosticCase. */
export type TurnImage = {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
};

export interface DiagnoseRequest {
  action: DiagnoseAction;
  problemText?: string;
  case?: DiagnosticCase;
  observation?: ObservationInput;
  image?: TurnImage;
}

export interface DiagnoseResponse {
  case: DiagnosticCase;
  /** Current open step; null when case is completed after FINISH. */
  nextStep: DiagnosticStep | null;
}

export interface DiagnosticEngine {
  startCase(problemText: string, image?: TurnImage): Promise<DiagnoseResponse>;
  continueCase(
    diagnosticCase: DiagnosticCase,
    observation: ObservationInput,
    image?: TurnImage,
  ): Promise<DiagnoseResponse>;
}
