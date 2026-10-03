import {
  getClaudeApiKey,
  getDiagnosticModel,
  getOpenAiApiKey,
  getStrongVerifierModel,
  getVerifierModel,
} from "./config";
import {
  DiagnosticPipelineError,
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
import {
  extractReferenceSpecClaims,
  mergeTechnicalSpecClaims,
} from "./spec-guard";
import { isSafetyCriticalTestDraft } from "./safety-guard";
import { resolveDiagnosisCertainty } from "./confirmation-guard";
import type {
  DiagnosticCase,
  DiagnosticEngine,
  DiagnosticStep,
  DiagnoseResponse,
  DiagnosisCertainty,
  ExtractedCaseFacts,
  Observation,
  ObservationInput,
  RejectedDiagnosis,
  TechnicianOutcome,
} from "./types";
import {
  assertObservationAllowed,
  sameObservation,
  stampObservation,
} from "./observation";
import { draftBlob } from "./text";
import {
  caseForTurn,
  persistSemanticUpdate,
  recordSemanticUpdate,
} from "./semantic-update";
import { toDiagnosticStep } from "./step-draft";
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

function hasTechnicalClaimsOrSpecs(draft: LlmStepPayload): boolean {
  const claims = Array.isArray(draft.technicalClaims) ? draft.technicalClaims : [];
  for (const c of claims) {
    const st = (c.sourceType ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    // GENERAL_PRINCIPLE fluff on ordinary ASK/TEST must not force verifier.
    if (c.vehicleSpecific === true) return true;
    if (st === "VERIFIED_OEM" || st === "VERIFIED_TECHNICAL") return true;
    if (
      (st === "MODEL_KNOWLEDGE" || st === "UNKNOWN") &&
      /\d/.test(`${c.valueText ?? ""} ${c.claim ?? ""}`)
    ) {
      return true;
    }
  }
  return extractReferenceSpecClaims(draftBlob(draft)).length > 0;
}

function hasHighConfidence(draft: LlmStepPayload): boolean {
  // Do NOT treat confidence:"high" alone — Claude often sets it on ordinary ASK/TEST.
  if (
    typeof draft.diagnosisConfidence === "number" &&
    draft.diagnosisConfidence >= 80
  ) {
    return true;
  }
  const certainty = (draft.diagnosisCertainty ?? "").toUpperCase();
  if (certainty === "CONFIRMED" || certainty === "HIGH_CONFIDENCE") return true;
  return false;
}

type VerifierRouteReason =
  | "finish"
  | "rejected_diagnosis"
  | "technical_claim_or_spec"
  | "safety_critical"
  | "high_confidence"
  | "none";

/**
 * OpenAI verifier only for high-risk drafts.
 * Ordinary ASK/TEST that pass backend guards go straight to UI (including first step).
 */
function shouldCallVerifier(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): VerifierRouteReason {
  if (draft.actionType === "FINISH") return "finish";
  if ((diagnosticCase.rejectedDiagnoses?.length ?? 0) > 0) {
    return "rejected_diagnosis";
  }
  if (hasTechnicalClaimsOrSpecs(draft)) return "technical_claim_or_spec";

  // Ordinary ASK (incl. first step): never call OpenAI after guards.
  if (draft.actionType === "ASK") return "none";

  if (draft.actionType === "TEST") {
    if (isSafetyCriticalTestDraft(draft)) return "safety_critical";
    if (hasHighConfidence(draft)) return "high_confidence";
    return "none";
  }

  return "none";
}

/**
 * Strong verifier only when the case is truly stuck after primary+retry.
 * Never on normal ASK; never on ordinary TEST without stuck signals.
 * Max 1× per case (enforced via strongVerifierUsed).
 */
function shouldEscalateToStrongVerifier(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  previousIssues: string[],
): boolean {
  if (diagnosticCase.strongVerifierUsed) return false;
  if (!getStrongVerifierModel()) return false;
  if (draft.actionType === "ASK") return false;
  if (previousIssues.length === 0) return false;

  if (draft.actionType === "FINISH") return true;
  if (draft.actionType === "TEST") {
    return (
      isSafetyCriticalTestDraft(draft) ||
      hasTechnicalClaimsOrSpecs(draft) ||
      hasHighConfidence(draft)
    );
  }

  return false;
}

function findDraftQualityIssueInTurn(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): GuardIssue | null {
  return findDraftQualityIssue(
    caseForTurn(turn, diagnosticCase),
    draft,
    turn.technicianOutcome,
  );
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

  const draft = parseJson<LlmStepPayload>(raw, "Claude dijagnostički odgovor");
  logDiagnosticDraftShape(draft);
  recordSemanticUpdate(turn, diagnosticCase, draft);
  return draft;
}

async function regenerateWithClaude(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
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
    guard: primaryGuard ? classifyGuardName(primaryGuard) : "verifier",
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
  const turnCase = caseForTurn(turn, diagnosticCase);
  const raw = await callOpenAiJson({
    apiKey,
    model,
    system: VERIFIER_SYSTEM_PROMPT,
    user: buildVerifierUserPrompt(turnCase, draft, {
      previousIssues: options?.previousIssues,
      strongFinal: options?.strongFinal,
      technicianOutcome: turn.technicianOutcome,
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

function applyConfirmationPolicy(draft: LlmStepPayload): LlmStepPayload {
  if (draft.actionType !== "FINISH") return draft;
  const certainty = resolveDiagnosisCertainty(draft);
  return {
    ...draft,
    diagnosisCertainty: certainty,
    insufficientEvidence: certainty !== "CONFIRMED",
  };
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

      draft = applyConfirmationPolicy(draft);

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

/** Keep the first observation per stepId — matches `find()` first-wins. */
function dedupeObservationsByStepId(
  observations: Observation[],
): Observation[] {
  const firstByStepId = new Map<string, Observation>();
  const out: Observation[] = [];
  for (const obs of observations) {
    const first = firstByStepId.get(obs.stepId);
    if (first) {
      if (
        process.env.NODE_ENV === "development" &&
        !sameObservation(first, obs)
      ) {
        console.warn(
          "[diagnosis] dropping duplicate observation for stepId",
          obs.stepId,
        );
      }
      continue;
    }
    firstByStepId.set(obs.stepId, obs);
    out.push(obs);
  }
  return out;
}

/** Fields scanned for locked technical-spec claims after an accepted step. */
function stepClaimText(step: DiagnosticStep): string {
  return [step.content, step.rationale, step.confirmedFault, step.testGuide]
    .filter(Boolean)
    .join("\n");
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
      status: "active",
    };

    const nextStep = await callVerifiedDiagnosticStep(baseCase);
    const isFinish = nextStep.actionType === "FINISH";
    const diagnosticCase: DiagnosticCase = {
      ...baseCase,
      extracted: baseCase.extracted,
      steps: [nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish ? nextStep.confirmedFault : undefined,
      technicalSpecClaims: mergeTechnicalSpecClaims(
        baseCase,
        stepClaimText(nextStep),
      ),
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
      observations: dedupeObservationsByStepId(diagnosticCase.observations),
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

    const reopen =
      observation.kind === "REJECT_DIAGNOSIS" ||
      observation.kind === "CONTINUE_AFTER_FINISH";
    const rejectedDiagnoses: RejectedDiagnosis[] = [
      ...(incoming.rejectedDiagnoses ?? []),
    ];
    if (observation.kind === "REJECT_DIAGNOSIS") {
      rejectedDiagnoses.push({
        diagnosis:
          currentStep.confirmedFault?.trim() || currentStep.content.trim(),
        rejectedAtStep: currentStep.id,
        reason: "technician_rejected",
        rejectedAt: new Date().toISOString(),
      });
    }

    const caseWithObservation: DiagnosticCase = {
      ...incoming,
      observations: [...incoming.observations, nextObservation],
      ...(reopen
        ? {
            steps: incoming.steps.map((step) =>
              step.id === currentStep.id
                ? {
                    ...step,
                    diagnosisCertainty: "LIKELY" as DiagnosisCertainty,
                    insufficientEvidence: true,
                  }
                : step,
            ),
            status: "active" as const,
            confirmedFault: undefined,
            rejectedDiagnoses,
          }
        : {}),
    };

    const nextStep = await callVerifiedDiagnosticStep(caseWithObservation, {
      allowTechnicianOutcome: observation.kind === "RESULT",
    });
    const isFinish = nextStep.actionType === "FINISH";
    const updated: DiagnosticCase = {
      ...caseWithObservation,
      steps: [...caseWithObservation.steps, nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish
        ? nextStep.confirmedFault
        : caseWithObservation.confirmedFault,
      technicalSpecClaims: mergeTechnicalSpecClaims(
        caseWithObservation,
        stepClaimText(nextStep),
      ),
      strongVerifierUsed: caseWithObservation.strongVerifierUsed,
    };

    return { case: updated, nextStep };
  }
}
