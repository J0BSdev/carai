import {
  getClaudeApiKey,
  getDiagnosticModel,
  getOpenAiApiKey,
  getStrongVerifierModel,
  getVerifierModel,
} from "./config";
import {
  DiagnosticPipelineError,
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
  type VerifierCorrectionPatch,
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
import {
  downgradeUnjustifiedConfirmed,
  findConfirmationGuardIssue,
  resolveDiagnosisCertainty,
} from "./confirmation-guard";
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
  stripLegacyExtractedTechnicianOutcome,
} from "./semantic-update";
import { toDiagnosticStep } from "./step-draft";
import {
  parseVerifierIssues,
  sanitizeVerifierCorrection,
} from "./verifier-payload";
import { issue, type GuardIssue } from "./guard-issue";

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

function hasContradictoryStrongEvidence(draft: LlmStepPayload): boolean {
  const hyps = draft.hypotheses ?? [];
  const active = hyps.filter((h) => {
    const st = (h.status ?? "").toUpperCase();
    return (
      st === "LIKELY" ||
      st === "LEADING" ||
      st === "POSSIBLE" ||
      st === "SUPPORTED" ||
      (typeof h.confidence === "number" && h.confidence >= 40)
    );
  });
  if (active.length < 2) {
    return active.some(
      (h) =>
        (h.supportingEvidence?.length ?? 0) > 0 &&
        (h.contradictingEvidence?.length ?? 0) > 0,
    );
  }
  const withSupport = active.filter(
    (h) => (h.supportingEvidence?.length ?? 0) > 0,
  );
  const withContra = active.filter(
    (h) => (h.contradictingEvidence?.length ?? 0) > 0,
  );
  return (
    withSupport.length >= 2 ||
    (withSupport.length >= 1 && withContra.length >= 1)
  );
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

  const safetyUnclear = isSafetyCriticalTestDraft(draft);
  const contradictory = hasContradictoryStrongEvidence(draft);

  if (draft.actionType === "FINISH") {
    return true;
  }

  if (draft.actionType === "TEST") {
    return safetyUnclear || contradictory;
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

function mergeVerifierCorrection(
  draft: LlmStepPayload,
  correction: VerifierCorrectionPatch,
): LlmStepPayload {
  return { ...draft, ...correction };
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
    correction?: unknown;
  }>(raw, "OpenAI verifier odgovor");
  const issues = parseVerifierIssues(parsed.issues);
  const approved = parsed.approved === true && issues.length === 0;
  const correction = approved
    ? null
    : sanitizeVerifierCorrection(parsed.correction);

  return { approved, issues, correction };
}

async function applyConfirmationPolicy(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  technicianOutcome?: TechnicianOutcome | null,
): Promise<LlmStepPayload> {
  if (draft.actionType !== "FINISH") return draft;
  const issue = findConfirmationGuardIssue(
    diagnosticCase,
    draft,
    technicianOutcome,
  );
  if (!issue) {
    const certainty = resolveDiagnosisCertainty(draft);
    return {
      ...draft,
      diagnosisCertainty: certainty,
      insufficientEvidence: certainty !== "CONFIRMED",
    };
  }
  return {
    ...downgradeUnjustifiedConfirmed(draft, issue),
    actionType: "FINISH",
  } as LlmStepPayload;
}

function rejectUnapprovedDraft(issues: string[]): never {
  const summary = issues.filter(Boolean).slice(0, 2).join("; ") || "odbijen";
  throw new DiagnosticPipelineError(`Verifier nije odobrio draft: ${summary}`);
}

function isGuardIssueValue(value: GuardIssue | string | undefined): value is GuardIssue {
  return typeof value === "object" && value !== null && "code" in value;
}

/** Isolated retry copy — structural FINISH invariant, not a new diagnosis. */
const TECHNICIAN_OUTCOME_RETRY_ISSUES = [
  "Current mechanic result je semantički interpretiran kao FAULT_CONFIRMED/REPAIR_CONFIRMED.",
  "Ponovno evaluiraj cijeli CASE STATE i vrati ispravan FINISH ako ta potvrda i dalje vrijedi.",
  "Ne vraćaj ASK/TEST samo radi nastavka dijagnostike.",
  "Ne izmišljaj OEM/spec vrijednosti.",
  "Ako nakon reevaluacije technicianOutcome nije opravdan, izostavi ga i normalno odaberi ASK|TEST|FINISH.",
];

function technicianOutcomeRetryIssues(): Array<GuardIssue | string> {
  const [first, ...rest] = TECHNICIAN_OUTCOME_RETRY_ISSUES;
  return [issue("TECHNICIAN_OUTCOME", first!), ...rest];
}

function retryIssuesFor(
  issue: GuardIssue | null,
  extra: GuardIssue[],
): Array<GuardIssue | string> {
  const items: Array<GuardIssue | string> = [
    ...(issue ? [issue] : []),
    ...extra,
  ];
  if (items.some((item) => isGuardIssueValue(item) && item.code === "TECHNICIAN_OUTCOME")) {
    return technicianOutcomeRetryIssues();
  }
  if (items.some((item) => isGuardIssueValue(item) && item.code === "SAFETY_REJECT")) {
    return [
      ...items,
      "Isti TEST. Dodaj 1 kratku praktičnu rečenicu što napraviti PRIJE rada. Ne checklista. Ne izmišljaj wait time.",
    ];
  }
  if (items.some((item) => isGuardIssueValue(item) && item.code === "TEST_META")) {
    return [
      ...items,
      "TEST mora imati diagnosticTarget, diagnosticGoal i testMethod.",
    ];
  }
  return items;
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
      draft = await applyConfirmationPolicy(
        caseForTurn(turn, diagnosticCase),
        draft,
        turn.technicianOutcome,
      );

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

      draft = await applyConfirmationPolicy(
        caseForTurn(turn, diagnosticCase),
        draft,
        turn.technicianOutcome,
      );

      persistSemanticUpdate(diagnosticCase, turn);
      return toDiagnosticStep(draft, stepId);
    },
  );
}

async function applyVerifierCorrection(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  correction: VerifierCorrectionPatch,
): Promise<LlmStepPayload> {
  const merged = mergeVerifierCorrection(draft, correction);
  const correctedIssue = findDraftQualityIssueInTurn(
    turn,
    diagnosticCase,
    merged,
  );
  if (!correctedIssue) return merged;
  return ensureDraftPassesQualityGates(turn, diagnosticCase, merged, [
    correctedIssue,
  ]);
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

  if (verdict.correction) {
    return applyVerifierCorrection(
      turn,
      diagnosticCase,
      draft,
      verdict.correction,
    );
  }

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
    if (verdict.correction) {
      return applyVerifierCorrection(
        turn,
        diagnosticCase,
        draft,
        verdict.correction,
      );
    }
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
  const turnCase = caseForTurn(turn, diagnosticCase);
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

  if (verdict.correction) {
    const corrected = mergeVerifierCorrection(draft, verdict.correction);
    const correctedIssue = findDraftQualityIssueInTurn(
      turn,
      diagnosticCase,
      corrected,
    );
    if (!correctedIssue) {
      return applyConfirmationPolicy(
        turnCase,
        corrected,
        turn.technicianOutcome,
      );
    }
    rejectUnapprovedDraft([
      ...previousIssues,
      ...verdict.issues,
      correctedIssue.message,
    ]);
  }

  rejectUnapprovedDraft([...previousIssues, ...verdict.issues]);
}

async function ensureDraftPassesQualityGates(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
  extraIssues: GuardIssue[] = [],
): Promise<LlmStepPayload> {
  let draft = await applyConfirmationPolicy(
    caseForTurn(turn, diagnosticCase),
    initialDraft,
    turn.technicianOutcome,
  );
  let pending = [...extraIssues];

  for (;;) {
    const issue = findDraftQualityIssueInTurn(turn, diagnosticCase, draft);
    if (!issue && pending.length === 0) return draft;
    if (turn.retriesUsed >= MAX_DIAGNOSTIC_RETRIES) {
      return finalizeAfterRetryLimit(turn, diagnosticCase, draft, issue);
    }
    draft = await regenerateWithClaude(
      turn,
      diagnosticCase,
      draft,
      retryIssuesFor(issue, pending),
    );
    pending = [];
    draft = await applyConfirmationPolicy(
      caseForTurn(turn, diagnosticCase),
      draft,
      turn.technicianOutcome,
    );
  }
}

/**
 * Retry budget spent. A failing ASK/TEST is never turned into a FINISH.
 * An existing FINISH may only be softened by the confirmation policy.
 */
async function finalizeAfterRetryLimit(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  issue: GuardIssue | null,
): Promise<LlmStepPayload> {
  if (!issue) return draft;

  if (draft.actionType === "FINISH") {
    const softened = await applyConfirmationPolicy(
      caseForTurn(turn, diagnosticCase),
      draft,
      turn.technicianOutcome,
    );
    if (!findDraftQualityIssueInTurn(turn, diagnosticCase, softened)) {
      return softened;
    }
  }

  throw new DiagnosticPipelineError(
    `Draft nije prošao quality guard nakon retry limita: ${issue.message}`,
  );
}

function formatStepMessage(
  actionType: string,
  diagnosticCase: DiagnosticCase,
  suffix = "",
): string {
  const strong = diagnosticCase.strongVerifierUsed
    ? ` + strong ${getStrongVerifierModel()}`
    : "";
  return `AI (${getDiagnosticModel()} + verifier ${getVerifierModel()}${strong}): ${actionType}${suffix}`;
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
  return [step.content, step.rationale, step.confirmedFault]
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

    return {
      case: diagnosticCase,
      nextStep,
      message: formatStepMessage(nextStep.actionType, diagnosticCase),
    };
  }

  async continueCase(
    diagnosticCase: DiagnosticCase,
    observation: ObservationInput,
  ): Promise<DiagnoseResponse> {
    const incoming: DiagnosticCase = {
      ...diagnosticCase,
      extracted:
        stripLegacyExtractedTechnicianOutcome(diagnosticCase.extracted) ?? {},
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
      return { case: incoming, nextStep: currentStep };
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

    const suffix =
      observation.kind === "REJECT_DIAGNOSIS"
        ? " (reevaluate after rejection)"
        : observation.kind === "CONTINUE_AFTER_FINISH"
          ? " (reevaluate after continue)"
          : "";

    return {
      case: updated,
      nextStep,
      message: formatStepMessage(nextStep.actionType, updated, suffix),
    };
  }
}
