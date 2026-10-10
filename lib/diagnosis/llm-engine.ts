import {
  getClaudeApiKey,
  getDiagnosticModel,
  getOpenAiApiKey,
  getStrongVerifierModel,
  getVerifierModel,
} from "./config";
import {
  DiagnosticPipelineError,
  DraftShapeError,
  InvalidObservationError,
  ObservationConflictError,
} from "./errors";
import {
  classifyGuardName,
  getActiveAiStep,
  logDiagnosticDraftShape,
  logGuardRetry,
  logRetryPromptChars,
  logVerifierRoute,
  runAiStep,
} from "./ai-telemetry";
import {
  callAnthropicJson,
  callOpenAiJson,
  parseJson,
  type LlmStepPayload,
  type VerifierPayload,
} from "./providers";
import {
  DIAGNOSTIC_SYSTEM_PROMPT,
  VERIFIER_SYSTEM_PROMPT,
  buildDiagnosticRetryPrompt,
  buildDiagnosticUserPrompt,
  buildVerifierUserPrompt,
  findDraftQualityIssue,
} from "./prompts";
import { draftHasSpecRisk } from "./safety-guard";
import type {
  DiagnosticCase,
  DiagnosticEngine,
  DiagnosticStep,
  DiagnoseResponse,
  ExtractedCaseFacts,
  ObservationInput,
  TechnicianOutcome,
} from "./types";
import {
  assertObservationAllowed,
  assertUniqueObservations,
  sameObservation,
  stampObservation,
} from "./observation";
import {
  caseForTurn,
  deriveSemanticState,
  persistSemanticUpdate,
  recordSemanticUpdate,
} from "./semantic-update";
import { parseDiagnosticDraft, toDiagnosticStep } from "./step-draft";
import { parseVerifierVerdict } from "./verifier-payload";
import type { GuardIssue } from "./guard-issue";

/** Max Claude regenerations after the initial draft, per user step. */
const MAX_DIAGNOSTIC_RETRIES = 2;

/**
 * Mutable state of one diagnostic turn. The semantic delta belongs to the turn, not
 * to a single draft: a guard retry that omits semanticUpdate must not drop facts an
 * earlier draft of the same turn already extracted.
 * technicianOutcome is REPLACE-per-draft and never accumulated across retries.
 */
type DiagnosticTurn = {
  retriesUsed: number;
  extracted: ExtractedCaseFacts | null;
  technicianOutcome: TechnicianOutcome | null;
  /** True only on continue after a mechanic result. startCase is always false. */
  allowTechnicianOutcome: boolean;
};

type VerifierRouteReason =
  | "finish"
  | "rejected_diagnosis"
  | "spec_risk"
  | "none";

/** Verifier only for FINISH, a rejected diagnosis, or a spec-risk draft. */
function shouldCallVerifier(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): VerifierRouteReason {
  if (draft.actionType === "FINISH") return "finish";
  if (diagnosticCase.observations.some((obs) => obs.kind === "REJECT_DIAGNOSIS")) {
    return "rejected_diagnosis";
  }
  if (draftHasSpecRisk(draft)) return "spec_risk";
  return "none";
}

/** Strong verifier once, after the primary verifier rejected a high-risk draft. */
function shouldEscalateToStrongVerifier(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  previousIssues: string[],
): boolean {
  if (diagnosticCase.strongVerifierUsed) return false;
  if (!getStrongVerifierModel()) return false;
  if (previousIssues.length === 0) return false;
  return shouldCallVerifier(diagnosticCase, draft) !== "none";
}

function findDraftQualityIssueInTurn(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): GuardIssue | null {
  const candidate = deriveSemanticState(
    diagnosticCase.extracted,
    draft.semanticUpdate,
    turn.allowTechnicianOutcome,
  );
  return findDraftQualityIssue(draft, candidate.technicianOutcome);
}

async function draftWithClaude(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  userPrompt: string,
  callMeta?: {
    role: "diagnostic" | "diagnostic_retry";
    reasonCalled: string;
    retryNumber: number;
  },
): Promise<LlmStepPayload> {
  const apiKey = getClaudeApiKey();
  if (!apiKey) {
    throw new Error("Nedostaje CLAUDE_API_KEY. Postavi ga u .env.");
  }

  const step = getActiveAiStep();
  const raw = await callAnthropicJson({
    apiKey,
    model: getDiagnosticModel(),
    system: DIAGNOSTIC_SYSTEM_PROMPT,
    user: userPrompt,
    telemetry: step
      ? {
          caseId: step.caseId,
          stepId: step.stepId,
          stepNumber: step.stepNumber,
          role: callMeta?.role ?? "diagnostic",
          reasonCalled: callMeta?.reasonCalled ?? "initial",
          retryNumber: callMeta?.retryNumber ?? 0,
        }
      : undefined,
  });

  try {
    const draft = parseDiagnosticDraft(raw);
    logDiagnosticDraftShape(draft);
    return draft;
  } catch (error) {
    if (!(error instanceof DraftShapeError)) throw error;
    if (turn.retriesUsed >= MAX_DIAGNOSTIC_RETRIES) {
      throw new DiagnosticPipelineError(error.message);
    }
    return regenerateWithClaude(
      turn,
      diagnosticCase, 
      {},
      [error.message],
      "draft_shape",
    );
  }
}

async function regenerateWithClaude(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: unknown,
  issues: Array<GuardIssue | string>,
  reasonCalled: string = "quality_gate",
): Promise<LlmStepPayload> {
  if (turn.retriesUsed >= MAX_DIAGNOSTIC_RETRIES) {
    throw new Error(
      `Dosegnut MAX_DIAGNOSTIC_RETRIES=${MAX_DIAGNOSTIC_RETRIES}; nema dodatnih Claude retryjeva.`,
    );
  }
  turn.retriesUsed += 1;

  const step = getActiveAiStep();
  const primaryIssue = issues[0];
  const primaryGuard = isGuardIssueValue(primaryIssue) ? primaryIssue : null;
  const issueSummary = isGuardIssueValue(primaryIssue)
    ? primaryIssue.message
    : typeof primaryIssue === "string"
      ? primaryIssue
      : reasonCalled;
  logGuardRetry({
    stepNumber: step?.stepNumber ?? diagnosticCase.steps.length + 1,
    guard: primaryGuard ? classifyGuardName(primaryGuard) : reasonCalled,
    retryNumber: turn.retriesUsed,
    issueSummary,
  });

  const turnCase = caseForTurn(turn, diagnosticCase);
  const retryPrompt = buildDiagnosticRetryPrompt(turnCase, draft, issues);
  logRetryPromptChars(retryPrompt.length);
  return draftWithClaude(
    turn,
    turnCase,
    retryPrompt,
    {
      role: "diagnostic_retry",
      reasonCalled,
      retryNumber: turn.retriesUsed,
    },
  );
}

async function verifyWithOpenAi(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  options?: {
    model?: string;
    previousIssues?: string[];
    strongFinal?: boolean;
    retryNumber?: number;
    reasonCalled?: string;
  },
): Promise<VerifierPayload> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("Nedostaje OPENAI_API_KEY. Postavi ga u .env.");
  }

  const model = options?.model ?? getVerifierModel();
  const step = getActiveAiStep();
  const candidate = deriveSemanticState(
    diagnosticCase.extracted,
    draft.semanticUpdate,
    turn.allowTechnicianOutcome,
  );
  const verifierCase: DiagnosticCase =
    candidate.extracted != null
      ? { ...diagnosticCase, extracted: candidate.extracted }
      : diagnosticCase;
  const raw = await callOpenAiJson({
    apiKey,
    model,
    system: VERIFIER_SYSTEM_PROMPT,
    user: buildVerifierUserPrompt(verifierCase, draft, {
      previousIssues: options?.previousIssues,
      strongFinal: options?.strongFinal,
      technicianOutcome: candidate.technicianOutcome,
    }),
    telemetry: step
      ? {
          caseId: step.caseId,
          stepId: step.stepId,
          stepNumber: step.stepNumber,
          role: options?.strongFinal ? "strong_verifier" : "verifier",
          reasonCalled:
            options?.reasonCalled ??
            (options?.strongFinal ? "strong_escalate" : "verifier_required"),
          retryNumber: options?.retryNumber ?? 0,
        }
      : undefined,
  });

  const parsed = parseJson<{
    approved?: unknown;
    issues?: unknown;
  }>(raw, "OpenAI verifier odgovor");
  return parseVerifierVerdict(parsed);
}

function rejectUnapprovedDraft(issues: string[]): never {
  const summary = issues.filter(Boolean).slice(0, 2).join("; ") || "odbijen";
  throw new DiagnosticPipelineError(`Verifier nije odobrio draft: ${summary}`);
}

function isGuardIssueValue(value: GuardIssue | string | undefined): value is GuardIssue {
  return typeof value === "object" && value !== null && "code" in value;
}

function retryIssuesFor(issue: GuardIssue): Array<GuardIssue | string> {
  if (issue.code === "TECHNICIAN_OUTCOME") {
    return [
      issue,
      "Ako potvrda vrijedi, vrati FINISH. Inače izostavi technicianOutcome.",
    ];
  }
  return [issue];
}

async function callVerifiedDiagnosticStep(
  diagnosticCase: DiagnosticCase,
  options?: { allowTechnicianOutcome?: boolean },
): Promise<DiagnosticStep> {
  const stepNumber = diagnosticCase.steps.length + 1;
  const stepId = `step-${stepNumber}`;
  const turn: DiagnosticTurn = {
    retriesUsed: 0,
    extracted: null,
    technicianOutcome: null,
    allowTechnicianOutcome: options?.allowTechnicianOutcome === true,
  };

  return runAiStep(
    {
      caseId: diagnosticCase.id,
      stepId,
      stepNumber,
    },
    async () => {
      let draft = await draftWithClaude(
        turn,
        diagnosticCase,
        buildDiagnosticUserPrompt(diagnosticCase),
        { role: "diagnostic", reasonCalled: "initial", retryNumber: 0 },
      );

      draft = await ensureDraftPassesQualityGates(turn, diagnosticCase, draft);

      const verifierReason = shouldCallVerifier(
        caseForTurn(turn, diagnosticCase),
        draft,
      );
      logVerifierRoute(verifierReason);
      if (verifierReason !== "none") {
        draft = await runSelectiveVerifier(
          turn,
          diagnosticCase,
          draft,
          verifierReason,
        );
      }

      persistSemanticUpdate(diagnosticCase, turn);
      return toDiagnosticStep(draft, stepId);
    },
  );
}

async function runSelectiveVerifier(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
  reasonCalled: Exclude<VerifierRouteReason, "none">,
): Promise<LlmStepPayload> {
  let draft = initialDraft;
  const collectedIssues: string[] = [];

  let verdict = await verifyWithOpenAi(turn, diagnosticCase, draft, {
    retryNumber: 0,
    reasonCalled,
  });
  if (verdict.approved) return draft;

  collectedIssues.push(
    ...(verdict.issues.length
      ? verdict.issues
      : ["Primary verifier odbio draft"]),
  );

  if (turn.retriesUsed < MAX_DIAGNOSTIC_RETRIES) {
    draft = await regenerateWithClaude(
      turn,
      diagnosticCase,
      draft,
      collectedIssues,
      "verifier_rejected",
    );
    draft = await ensureDraftPassesQualityGates(turn, diagnosticCase, draft);

    const retryReason = shouldCallVerifier(
      caseForTurn(turn, diagnosticCase),
      draft,
    );
    logVerifierRoute(retryReason);
    if (retryReason === "none") {
      return draft;
    }

    verdict = await verifyWithOpenAi(turn, diagnosticCase, draft, {
      retryNumber: 1,
      reasonCalled: retryReason,
    });
    if (verdict.approved) return draft;
    collectedIssues.push(
      ...(verdict.issues.length
        ? verdict.issues
        : ["Primary verifier odbio i nakon retryja"]),
    );
  }

  const turnCase = caseForTurn(turn, diagnosticCase);
  if (shouldEscalateToStrongVerifier(turnCase, draft, collectedIssues)) {
    return runStrongVerifierOnce(turn, diagnosticCase, draft, collectedIssues);
  }

  rejectUnapprovedDraft(collectedIssues);
}

async function runStrongVerifierOnce(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  previousIssues: string[],
): Promise<LlmStepPayload> {
  const strongModel = getStrongVerifierModel();
  if (!strongModel) {
    rejectUnapprovedDraft(previousIssues);
  }

  diagnosticCase.strongVerifierUsed = true;

  const verdict = await verifyWithOpenAi(turn, diagnosticCase, draft, {
    model: strongModel,
    previousIssues,
    strongFinal: true,
    retryNumber: 0,
    reasonCalled: "strong_escalate",
  });

  if (verdict.approved) return draft;
  rejectUnapprovedDraft([...previousIssues, ...verdict.issues]);
}

async function ensureDraftPassesQualityGates(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
): Promise<LlmStepPayload> {
  let draft = initialDraft;
  for (;;) {
    const issue = findDraftQualityIssueInTurn(turn, diagnosticCase, draft);
    if (!issue) return draft;
    if (turn.retriesUsed >= MAX_DIAGNOSTIC_RETRIES) {
      throw new DiagnosticPipelineError(
        `Draft nije prošao quality guard nakon retry limita: ${issue.message}`,
      );
    }
    draft = await regenerateWithClaude(
      turn,
      diagnosticCase,
      draft,
      retryIssuesFor(issue),
    );
  }
}

export class LlmDiagnosticEngine implements DiagnosticEngine {
  async startCase(problemText: string): Promise<DiagnoseResponse> {
    const trimmed = problemText.trim();
    if (!trimmed) {
      throw new Error("Za pokretanje dijagnoze potreban je opis kvara");
    }

    const baseCase: DiagnosticCase = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      problemText: trimmed,
      // Filled by the first draft's semanticUpdate — no backend text parsing.
      extracted: {},
      observations: [],
      steps: [],
    };

    const nextStep = await callVerifiedDiagnosticStep(baseCase);
    const diagnosticCase: DiagnosticCase = {
      ...baseCase,
      extracted: baseCase.extracted,
      steps: [nextStep],
      strongVerifierUsed: baseCase.strongVerifierUsed,
    };

    return { case: diagnosticCase, nextStep };
  }

  async continueCase(
    diagnosticCase: DiagnosticCase,
    observation: ObservationInput,
  ): Promise<DiagnoseResponse> {
    const incoming: DiagnosticCase = {
      ...diagnosticCase,
      extracted: diagnosticCase.extracted ?? {},
      observations: assertUniqueObservations(diagnosticCase.observations),
    };

    const currentStep = incoming.steps[incoming.steps.length - 1];
    if (!currentStep) {
      throw new Error("Slučaj nema aktivni korak za zabilježiti");
    }

    assertObservationAllowed(observation.kind, currentStep.actionType);

    const nextObservation = stampObservation(currentStep.id, observation);
    const existing = incoming.observations.find(
      (item) => item.stepId === currentStep.id,
    );
    if (existing) {
      if (!sameObservation(existing, nextObservation)) {
        throw new ObservationConflictError(
          `Conflicting second result for step ${currentStep.id}`,
        );
      }
      throw new InvalidObservationError(
        "Ovaj korak već ima zabilježen rezultat.",
      );
    }

    const caseWithObservation: DiagnosticCase = {
      ...incoming,
      observations: [...incoming.observations, nextObservation],
    };

    const nextStep = await callVerifiedDiagnosticStep(caseWithObservation, {
      allowTechnicianOutcome: observation.kind === "RESULT",
    });
    const updated: DiagnosticCase = {
      ...caseWithObservation,
      steps: [...caseWithObservation.steps, nextStep],
      strongVerifierUsed: caseWithObservation.strongVerifierUsed,
    };

    return { case: updated, nextStep };
  }
}
