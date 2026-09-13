import {
  getClaudeApiKey,
  getDiagnosticModel,
  getOpenAiApiKey,
  getStrongVerifierModel,
  getVerifierModel,
} from "./config";
import type { DiagnosticEngine } from "./engine";
import {
  classifyGuardName,
  getActiveAiStep,
  logGuardRetry,
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
import { extractFactsFromText, refreshExtractedFacts } from "./known-facts";
import { findReasoningConsistencyIssue } from "./reasoning-consistency-guard";
import { isSafetyCriticalTestDraft } from "./safety-guard";
import {
  downgradeUnjustifiedConfirmed,
  findConfirmationGuardIssue,
  isContinueAfterFinish,
  isTechnicianRejection,
  mapHypothesisUiStatus,
  resolveDiagnosisCertainty,
} from "./confirmation-guard";
import type {
  AiActionType,
  DiagnosticCase,
  DiagnosticStep,
  DiagnoseResponse,
  DiagnosisCertainty,
  Hypothesis,
  Observation,
  RejectedDiagnosis,
} from "./types";

/** Max Claude regenerations after the initial draft, per user step. */
const MAX_DIAGNOSTIC_RETRIES = 2;

type RetryBudget = { used: number };

const ALLOWED_ACTIONS: AiActionType[] = ["ASK", "TEST", "FINISH"];

function draftBlob(draft: LlmStepPayload): string {
  return [
    draft.content,
    draft.rationale,
    draft.expectedResultHint,
    draft.confirmedFault,
    ...(draft.facts ?? []),
    ...(draft.evidence ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

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

function looksExpensiveOrRiskyRecommendation(draft: LlmStepPayload): boolean {
  const n = draftBlob(draft)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return /(zamijeni|zamjeni|zamena|zamjena|replace\b|kupi nov|treba nov|ugradi nov|nova turbina|novi (ecu|pcm|modul|injektor|mjenjac|motor|katalizator)|skupa (popravka|zamjena|dijagnostik)|skupo |overhaul|komplet (turbine|mjenjaca|injektora))/.test(
    n,
  );
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

/**
 * OpenAI verifier only for high-risk drafts.
 * Ordinary ASK/TEST that pass backend guards go straight to UI (including first step).
 */
export function shouldCallVerifier(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): boolean {
  if (draft.actionType === "FINISH") return true;
  if ((diagnosticCase.rejectedDiagnoses?.length ?? 0) > 0) return true;
  if (findReasoningConsistencyIssue(diagnosticCase, draft)) return true;
  if (hasTechnicalClaimsOrSpecs(draft)) return true;

  // Ordinary ASK (incl. first step): never call OpenAI after guards.
  if (draft.actionType === "ASK") return false;

  if (draft.actionType === "TEST") {
    if (isSafetyCriticalTestDraft(draft)) return true;
    if (looksExpensiveOrRiskyRecommendation(draft)) return true;
    if (hasHighConfidence(draft)) return true;
    return false;
  }

  return false;
}

/**
 * Strong verifier only when the case is truly stuck after primary+retry.
 * Never on normal ASK; never on ordinary TEST without stuck signals.
 * Max 1× per case (enforced via strongVerifierUsed).
 */
export function shouldEscalateToStrongVerifier(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  previousIssues: string[],
): boolean {
  if (diagnosticCase.strongVerifierUsed) return false;
  if (!getStrongVerifierModel()) return false;
  if (draft.actionType === "ASK") return false;
  if (previousIssues.length === 0) return false;

  const reasoningStillBroken = Boolean(
    findReasoningConsistencyIssue(diagnosticCase, draft),
  );
  const safetyOrExpensiveUnclear =
    isSafetyCriticalTestDraft(draft) ||
    looksExpensiveOrRiskyRecommendation(draft);
  const contradictory = hasContradictoryStrongEvidence(draft);

  if (draft.actionType === "FINISH") {
    // Primary already failed on a FINISH — escalate once if strong available.
    return true;
  }

  if (draft.actionType === "TEST") {
    return (
      reasoningStillBroken ||
      safetyOrExpensiveUnclear ||
      contradictory
    );
  }

  return false;
}

function parseHypotheses(
  value: LlmStepPayload["hypotheses"],
): Hypothesis[] | undefined {
  if (!value || !Array.isArray(value)) return undefined;
  const parsed: Hypothesis[] = [];
  for (const h of value) {
    if (!h) continue;
    const label = (h.label ?? h.cause ?? "").trim();
    if (!label) continue;
    const confidence =
      typeof h.confidence === "number" && Number.isFinite(h.confidence)
        ? Math.max(0, Math.min(100, Math.round(h.confidence)))
        : h.confidence === null
          ? null
          : undefined;
    parsed.push({
      label,
      status: mapHypothesisUiStatus(h.status ?? "POSSIBLE"),
      note: h.note ?? undefined,
      confidence,
      supportingEvidence: h.supportingEvidence?.filter(Boolean),
      contradictingEvidence: h.contradictingEvidence?.filter(Boolean),
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

function parseDiagnosisConfidence(
  value: unknown,
): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  return undefined;
}

function toDiagnosticStep(
  payload: LlmStepPayload,
  stepId: string,
): DiagnosticStep {
  if (!ALLOWED_ACTIONS.includes(payload.actionType as AiActionType)) {
    throw new Error(
      `AI je vratio neispravan actionType: ${payload.actionType}. Očekivano ASK, TEST ili FINISH.`,
    );
  }
  if (!payload.content?.trim() || !payload.rationale?.trim()) {
    throw new Error("AI odgovor mora sadržavati content i rationale.");
  }

  const actionType = payload.actionType as AiActionType;
  let diagnosisCertainty: DiagnosisCertainty | undefined;
  let insufficientEvidence = payload.insufficientEvidence ?? undefined;
  let diagnosisConfidence = parseDiagnosisConfidence(payload.diagnosisConfidence);

  if (actionType === "FINISH") {
    diagnosisCertainty = resolveDiagnosisCertainty(payload);
    insufficientEvidence = diagnosisCertainty !== "CONFIRMED";
    if (
      diagnosisConfidence === undefined &&
      payload.hypotheses &&
      payload.hypotheses.length > 0
    ) {
      const top = [...payload.hypotheses]
        .map((h) => h.confidence)
        .filter((c): c is number => typeof c === "number")
        .sort((a, b) => b - a)[0];
      if (typeof top === "number") diagnosisConfidence = top;
    }
  }

  return {
    id: stepId,
    actionType,
    content: payload.content.trim(),
    rationale: payload.rationale.trim(),
    expectedResultHint: payload.expectedResultHint?.trim() || undefined,
    confirmedFault:
      actionType === "FINISH"
        ? payload.confirmedFault?.trim() || payload.content.trim()
        : undefined,
    confidence: payload.confidence ?? undefined,
    diagnosisCertainty,
    diagnosisConfidence,
    insufficientEvidence,
    facts: payload.facts ?? undefined,
    evidence: payload.evidence ?? undefined,
    hypotheses: parseHypotheses(payload.hypotheses),
  };
}

async function draftWithClaude(
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

  return parseJson<LlmStepPayload>(raw, "Claude dijagnostički odgovor");
}

async function regenerateWithClaude(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  issues: string[],
  budget: RetryBudget,
  reasonCalled: string = "quality_gate",
): Promise<LlmStepPayload> {
  if (budget.used >= MAX_DIAGNOSTIC_RETRIES) {
    throw new Error(
      `Dosegnut MAX_DIAGNOSTIC_RETRIES=${MAX_DIAGNOSTIC_RETRIES}; nema dodatnih Claude retryjeva.`,
    );
  }
  budget.used += 1;

  const step = getActiveAiStep();
  const primaryIssue = issues[0] ?? reasonCalled;
  logGuardRetry({
    stepNumber: step?.stepNumber ?? diagnosticCase.steps.length + 1,
    guard: classifyGuardName(primaryIssue),
    retryNumber: budget.used,
    issueSummary: primaryIssue,
  });

  return draftWithClaude(
    diagnosticCase,
    buildDiagnosticRetryPrompt(diagnosticCase, draft, issues),
    {
      role: "diagnostic_retry",
      reasonCalled,
      retryNumber: budget.used,
    },
  );
}

async function verifyWithOpenAi(
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
  const raw = await callOpenAiJson({
    apiKey,
    model,
    system: VERIFIER_SYSTEM_PROMPT,
    user: buildVerifierUserPrompt(diagnosticCase, draft, {
      previousIssues: options?.previousIssues,
      strongFinal: options?.strongFinal,
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

  const parsed = parseJson<VerifierPayload>(raw, "OpenAI verifier odgovor");
  const verdict: VerifierPayload = {
    approved: Boolean(parsed.approved),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    correctedStep: parsed.correctedStep ?? null,
  };

  const contradiction =
    findReasoningConsistencyIssue(diagnosticCase, draft) ??
    (verdict.correctedStep
      ? findReasoningConsistencyIssue(diagnosticCase, verdict.correctedStep)
      : null);
  if (contradiction) {
    return {
      approved: false,
      issues: [contradiction, ...verdict.issues].slice(0, 3),
      correctedStep: null,
    };
  }

  return verdict;
}

async function applyConfirmationPolicy(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): Promise<LlmStepPayload> {
  if (draft.actionType !== "FINISH") return draft;
  const issue = findConfirmationGuardIssue(diagnosticCase, draft);
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

/**
 * Safe backend fallback after strong reject / terminal verifier failure.
 * Never CONFIRMED. No further AI escalation.
 */
function buildSafeVerifierFallback(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  issues: string[],
): LlmStepPayload {
  const issueSummary =
    issues.filter(Boolean).slice(0, 2).join("; ") ||
    "nedovoljno pouzdanih dokaza";

  if (draft.actionType === "FINISH") {
    let next: LlmStepPayload = {
      ...draft,
      actionType: "FINISH",
      diagnosisCertainty: "LIKELY",
      insufficientEvidence: true,
      confidence: "medium",
    };
    const confIssue = findConfirmationGuardIssue(diagnosticCase, next);
    if (confIssue) {
      next = {
        ...downgradeUnjustifiedConfirmed(next, confIssue),
        actionType: "FINISH",
      } as LlmStepPayload;
    }
    if ((next.diagnosisCertainty ?? "").toUpperCase() === "CONFIRMED") {
      next = {
        ...next,
        diagnosisCertainty: "LIKELY",
        insufficientEvidence: true,
      };
    }
    const certainty = resolveDiagnosisCertainty(next);
    const supportedLikely =
      certainty === "LIKELY" || certainty === "HIGH_CONFIDENCE";
    return {
      ...next,
      diagnosisCertainty: supportedLikely ? certainty : "SUSPECTED",
      insufficientEvidence: true,
      confirmedFault:
        next.confirmedFault?.trim() ||
        "Vodeća sumnja (nije CONFIRMED — potreban dodatni dokaz)",
      content:
        `${supportedLikely ? "LIKELY" : "SUSPECTED"} / NEEDS CONFIRMATION: ` +
        `${(next.content || next.confirmedFault || "vodeća sumnja").trim()}. ` +
        `Verifier nije odobrio potvrdu. Potreban dodatni dokaz (${issueSummary}).`,
      rationale: `Siguran fallback nakon verifier eskalacije — nema CONFIRMED bez dovoljnog dokaza. ${issueSummary}`,
    };
  }

  return {
    actionType: "ASK",
    content:
      "Prije sigurnog nastavka potreban je dodatni konkretan dokaz. Koje mjerenje ili opažanje možeš sada dodati?",
    rationale: `Siguran fallback: verifier nije odobrio korak (${issueSummary}). Nema daljnje AI eskalacije.`,
    expectedResultHint: "Konkretan rezultat mjerenja ili opažanja",
    confirmedFault: null,
    confidence: "low",
    insufficientEvidence: true,
    askDecision: {
      whyNeeded:
        "Bez dodatnog dokaza nije sigurno nastaviti nakon verifier odbijanja",
      expectedAnswers: [
        "Imam novo mjerenje/opažanje",
        "Nemam dodatni dokaz sada",
      ],
      nextStepByAnswer: [
        {
          answer: "Imam novo mjerenje/opažanje",
          nextAction: "TEST ili reevaluate prema novom dokazu",
        },
        {
          answer: "Nemam dodatni dokaz sada",
          nextAction: "FINISH LIKELY/SUSPECTED s insufficientEvidence",
        },
      ],
    },
    facts: draft.facts ?? null,
    evidence: draft.evidence ?? null,
    hypotheses: draft.hypotheses ?? null,
  };
}

function buildGuardRetryIssues(
  draft: LlmStepPayload,
  issue: string | null,
  extraIssues: string[],
): string[] {
  const askRejected =
    draft.actionType === "ASK" ||
    extraIssues.some((i) => /ASK REJECT/i.test(i)) ||
    (issue != null && /ASK REJECT/i.test(issue));

  const safetyRejected =
    extraIssues.some((i) => /SAFETY REJECT/i.test(i)) ||
    (issue != null && /SAFETY REJECT/i.test(issue));

  return [
    ...(issue ? [issue] : []),
    ...extraIssues,
    "Predloži DRUGAČIJI sljedeći korak koristeći CASE STATE.",
    "Ne ponavljaj već postavljena pitanja ni završene/semantički slične testove.",
    askRejected
      ? "ASK je odbijen backend gateom. actionType MORA biti TEST — odmah odaberi najbolji sljedeći dijagnostički test. Ne vraćaj ASK."
      : "Ako ASK nema decision value → TEST. Ako TEST ne razlikuje hipoteze → bolji TEST ili FINISH.",
    safetyRejected
      ? "SAFETY REJECT: regeneriraj ISTI tip TEST-a ali s obaveznim safetyPreconditions + upozorenjima u content (SRS: deaktivacija/odspajanje napajanja prije rada na konektorima/modulu; ne izmišljaj wait time — needsVerifiedProcedure)."
      : "Skipped test nije dokaz — ne parafraziraj ga.",
    safetyRejected ? "Skipped test nije dokaz — ne parafraziraj ga." : "",
  ].filter(Boolean);
}

/**
 * 3-tier pipeline:
 * 1) Claude proposes ASK/TEST/FINISH.
 * 2) Programmatic guards (bounded Claude retries).
 * 3) Primary verifier only when selective conditions match.
 * 4) Strong verifier at most once per case when still stuck; else safe fallback.
 */
async function callVerifiedDiagnosticStep(
  diagnosticCase: DiagnosticCase,
): Promise<DiagnosticStep> {
  const stepNumber = diagnosticCase.steps.length + 1;
  const stepId = `step-${stepNumber}`;
  const budget: RetryBudget = { used: 0 };

  return runAiStep(
    {
      caseId: diagnosticCase.id,
      stepId,
      stepNumber,
    },
    async () => {
      let draft = await draftWithClaude(
        diagnosticCase,
        buildDiagnosticUserPrompt(diagnosticCase),
        { role: "diagnostic", reasonCalled: "initial", retryNumber: 0 },
      );

      draft = await ensureDraftPassesQualityGates(diagnosticCase, draft, budget);
      draft = await applyConfirmationPolicy(diagnosticCase, draft);

      if (shouldCallVerifier(diagnosticCase, draft)) {
        draft = await runSelectiveVerifier(diagnosticCase, draft, budget);
      }

      draft = await applyConfirmationPolicy(diagnosticCase, draft);
      return toDiagnosticStep(draft, stepId);
    },
  );
}

async function applyVerifierCorrection(
  diagnosticCase: DiagnosticCase,
  corrected: LlmStepPayload,
  budget: RetryBudget,
): Promise<LlmStepPayload> {
  const correctedIssue = findDraftQualityIssue(diagnosticCase, corrected);
  if (!correctedIssue) return corrected;
  return ensureDraftPassesQualityGates(diagnosticCase, corrected, budget, [
    correctedIssue,
    "Predloži drugačiji korak bez ponavljanja iste dijagnostičke grane.",
  ]);
}

async function runSelectiveVerifier(
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
  budget: RetryBudget,
): Promise<LlmStepPayload> {
  let draft = initialDraft;
  const collectedIssues: string[] = [];

  let verdict = await verifyWithOpenAi(diagnosticCase, draft, {
    retryNumber: 0,
    reasonCalled: "verifier_required",
  });
  if (verdict.approved) return draft;

  if (verdict.correctedStep) {
    return applyVerifierCorrection(
      diagnosticCase,
      verdict.correctedStep,
      budget,
    );
  }

  collectedIssues.push(
    ...(verdict.issues.length
      ? verdict.issues
      : ["Primary verifier odbio draft"]),
  );

  if (budget.used < MAX_DIAGNOSTIC_RETRIES) {
    draft = await regenerateWithClaude(
      diagnosticCase,
      draft,
      collectedIssues,
      budget,
      "verifier_rejected",
    );
    draft = await ensureDraftPassesQualityGates(diagnosticCase, draft, budget);

    if (!shouldCallVerifier(diagnosticCase, draft)) {
      return draft;
    }

    verdict = await verifyWithOpenAi(diagnosticCase, draft, {
      retryNumber: 1,
      reasonCalled: "verifier_required",
    });
    if (verdict.approved) return draft;
    if (verdict.correctedStep) {
      return applyVerifierCorrection(
        diagnosticCase,
        verdict.correctedStep,
        budget,
      );
    }
    collectedIssues.push(
      ...(verdict.issues.length
        ? verdict.issues
        : ["Primary verifier odbio i nakon retryja"]),
    );
  }

  if (shouldEscalateToStrongVerifier(diagnosticCase, draft, collectedIssues)) {
    return runStrongVerifierOnce(diagnosticCase, draft, collectedIssues);
  }

  return buildSafeVerifierFallback(diagnosticCase, draft, collectedIssues);
}

async function runStrongVerifierOnce(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  previousIssues: string[],
): Promise<LlmStepPayload> {
  const strongModel = getStrongVerifierModel();
  if (!strongModel) {
    return buildSafeVerifierFallback(diagnosticCase, draft, previousIssues);
  }

  diagnosticCase.strongVerifierUsed = true;

  const verdict = await verifyWithOpenAi(diagnosticCase, draft, {
    model: strongModel,
    previousIssues,
    strongFinal: true,
    retryNumber: 0,
    reasonCalled: "strong_escalate",
  });

  if (verdict.approved) {
    return draft;
  }

  if (verdict.correctedStep) {
    const correctedIssue = findDraftQualityIssue(
      diagnosticCase,
      verdict.correctedStep,
    );
    if (!correctedIssue) {
      return applyConfirmationPolicy(diagnosticCase, verdict.correctedStep);
    }
    return buildSafeVerifierFallback(diagnosticCase, draft, [
      ...previousIssues,
      ...verdict.issues,
      correctedIssue,
    ]);
  }

  return buildSafeVerifierFallback(diagnosticCase, draft, [
    ...previousIssues,
    ...verdict.issues,
  ]);
}

async function ensureDraftPassesQualityGates(
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
  budget: RetryBudget,
  extraIssues: string[] = [],
): Promise<LlmStepPayload> {
  let draft = initialDraft;

  if (draft.actionType === "FINISH") {
    const confIssue = findConfirmationGuardIssue(diagnosticCase, draft);
    if (confIssue) {
      draft = {
        ...downgradeUnjustifiedConfirmed(draft, confIssue),
        actionType: "FINISH",
      } as LlmStepPayload;
    }
  }

  let issue = findDraftQualityIssue(diagnosticCase, draft);
  let pendingExtra = [...extraIssues];
  if (!issue && pendingExtra.length === 0) return draft;

  if (budget.used >= MAX_DIAGNOSTIC_RETRIES) {
    return finalizeAfterRetryLimit(diagnosticCase, draft, issue);
  }

  draft = await regenerateWithClaude(
    diagnosticCase,
    draft,
    buildGuardRetryIssues(draft, issue, pendingExtra),
    budget,
  );
  pendingExtra = [];
  issue = findDraftQualityIssue(diagnosticCase, draft);

  if (
    draft.actionType === "ASK" &&
    issue &&
    budget.used < MAX_DIAGNOSTIC_RETRIES
  ) {
    draft = await regenerateWithClaude(
      diagnosticCase,
      draft,
      [
        issue,
        "OBAVEZNO: actionType=TEST. Nemoj vraćati ASK. Odaberi najbolji diskriminirajući test iz CASE STATE.",
      ],
      budget,
    );
    issue = findDraftQualityIssue(diagnosticCase, draft);
  }

  if (
    issue &&
    /SAFETY REJECT/i.test(issue) &&
    draft.actionType === "TEST" &&
    budget.used < MAX_DIAGNOSTIC_RETRIES
  ) {
    draft = await regenerateWithClaude(
      diagnosticCase,
      draft,
      [
        issue,
        "OBAVEZNO: actionType=TEST s safetyPreconditions.",
        "U content na početku navedi sigurnosne korake.",
        "SRS/airbag konektor/modul: deaktiviraj sustav / odspoji napajanje PRIJE rada.",
        "Ne izmišljaj vehicle-specific vrijeme čekanja — needsVerifiedProcedure=true.",
        "technicalClaims[]: svaka tvrdnja mora imati ispravan sourceType.",
      ],
      budget,
    );
    issue = findDraftQualityIssue(diagnosticCase, draft);
  }

  if (!issue) return draft;

  if (budget.used < MAX_DIAGNOSTIC_RETRIES) {
    draft = await regenerateWithClaude(
      diagnosticCase,
      draft,
      [
        issue,
        "OBAVEZNO: vrati akciju iz DRUGE dijagnostičke grane ILI FINISH.",
        "Zabranjeno: isti dio + ista vrsta mjerenja kao completedTests/skippedUnavailableTests.",
        "Ako completedTests snažno podupiru LEADING hipotezu → FINISH, ali BEZ izmišljenih OEM brojki; bez verifiedTechnicalSpecs ne smiješ CONFIRMED usporedbom measured vs expected.",
        "Inače: jedan TEST koji razlikuje LEADING od najjače alternative (druga metoda/točka/sustav).",
        "U rationale navedi koje hipoteze razlikuješ.",
        "Ne navodi NITI JEDAN vehicle-specific brojčani OEM/referentni raspon (Ω/V/bar/…) bez verifiedTechnicalSpecs.",
        "Ako actionType=FINISH: insufficientEvidence=true; LIKELY / NEEDS CONFIRMATION bez UNVERIFIED spece.",
      ],
      budget,
    );
    issue = findDraftQualityIssue(diagnosticCase, draft);
    if (!issue) return draft;
  }

  return finalizeAfterRetryLimit(diagnosticCase, draft, issue);
}

function finalizeAfterRetryLimit(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  issue: string | null,
): LlmStepPayload {
  if (!issue) return draft;

  const isSpecIssue = /UNVERIFIED SPEC|FINISH GUARD|CONSISTENCY:/i.test(issue);

  let next: LlmStepPayload = draft;
  if (draft.actionType !== "FINISH") {
    next = {
      ...draft,
      actionType: "FINISH",
      content: isSpecIssue
        ? "LIKELY / NEEDS CONFIRMATION: na temelju prikupljenih mjerenja i opažanja vodi se sumnja na navedeni uzrok, ali točan OEM/referentni raspon za ovo vozilo nije verificiran pa se usporedba measured vs expected ne smije koristiti kao potvrda. Potrebna je potvrda metodom koja ne ovisi o neprovjerenoj specifikaciji ili unos verificiranog podatka."
        : draft.content?.trim() ||
          "Na temelju prikupljenih dokaza vodeća dijagnoza je najvjerojatniji uzrok; dodatni slični testovi ne bi dali novu informaciju.",
      rationale: isSpecIssue
        ? "FINISH GUARD: requiresExactSpec bez verifiedSpec — dijagnoza ostaje LIKELY, ne CONFIRMED."
        : draft.rationale?.trim() ||
          "Dodatni semantički slični testovi ne mijenjaju ranking hipoteza — završavam na temelju postojećih dokaza.",
      insufficientEvidence: true,
      confidence: "medium",
      confirmedFault: isSpecIssue
        ? draft.confirmedFault?.trim() ||
          "Vodeća sumnja prema mjerenjima (nije potvrđeno verificiranom specifikacijom)"
        : draft.confirmedFault ??
          "Vodeća hipoteza prema dostupnim dokazima (provjeri insufficientEvidence).",
    };
  }

  const still = findDraftQualityIssue(diagnosticCase, next);
  if (!still) return next;

  if (next.actionType === "FINISH") {
    return {
      ...next,
      content:
        "LIKELY / NEEDS CONFIRMATION: dijagnoza se temelji na izmjerenim rezultatima i općim dijagnostičkim principima. Točan referentni raspon za ovo vozilo nije verificiran (specStatus=UNVERIFIED), stoga se ne potvrđuje usporedba measured vs expected OEM vrijednosti.",
      rationale:
        "Programski FINISH guard: odbijene neprovjerene/kontradiktorne specifikacije. UNVERIFIED SPEC nije dokaz.",
      insufficientEvidence: true,
      confidence: "medium",
      confirmedFault:
        "Vodeća sumnja (nije CONFIRMED — nedostaje verified specifikacija)",
      expectedResultHint: null,
    };
  }

  throw new Error(`AI draft odbijen: ${still}. Pokušaj ponovno.`);
}

function lightExtract(problemText: string): DiagnosticCase["extracted"] {
  return extractFactsFromText(problemText);
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
      extracted: lightExtract(trimmed),
      observations: [],
      steps: [],
      status: "active",
    };

    const nextStep = await callVerifiedDiagnosticStep(baseCase);
    const isFinish = nextStep.actionType === "FINISH";
    const draftText = [
      nextStep.content,
      nextStep.rationale,
      nextStep.confirmedFault,
    ]
      .filter(Boolean)
      .join("\n");

    const diagnosticCase: DiagnosticCase = {
      ...baseCase,
      extracted: lightExtract(trimmed),
      steps: [nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish ? nextStep.confirmedFault : undefined,
      technicalSpecClaims: mergeTechnicalSpecClaims(baseCase, draftText),
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
    resultText: string,
  ): Promise<DiagnoseResponse> {
    const trimmed = resultText.trim();
    if (!trimmed) {
      throw new Error("Za nastavak dijagnoze potreban je rezultat ili odgovor");
    }

    const currentStep = diagnosticCase.steps[diagnosticCase.steps.length - 1];
    if (!currentStep) {
      throw new Error("Slučaj nema aktivni korak za zabilježiti");
    }

    const reopenAfterFinish =
      currentStep.actionType === "FINISH" &&
      (isTechnicianRejection(trimmed) || isContinueAfterFinish(trimmed));

    if (diagnosticCase.status === "completed" && !reopenAfterFinish) {
      return {
        case: diagnosticCase,
        nextStep: null,
        message: "Slučaj je već završen.",
      };
    }

    if (currentStep.actionType === "FINISH") {
      if (!reopenAfterFinish) {
        return {
          case: {
            ...diagnosticCase,
            status: "completed",
            confirmedFault: currentStep.confirmedFault,
          },
          nextStep: null,
          message: "Slučaj označen kao riješen (FINISH).",
        };
      }

      const rejectedDiagnoses: RejectedDiagnosis[] = [
        ...(diagnosticCase.rejectedDiagnoses ?? []),
      ];
      if (isTechnicianRejection(trimmed)) {
        rejectedDiagnoses.push({
          diagnosis:
            currentStep.confirmedFault?.trim() || currentStep.content.trim(),
          rejectedAtStep: currentStep.id,
          reason: "technician_rejected",
          rejectedAt: new Date().toISOString(),
        });
      }

      const softenedSteps = diagnosticCase.steps.map((s) =>
        s.id === currentStep.id
          ? {
              ...s,
              diagnosisCertainty: "LIKELY" as DiagnosisCertainty,
              insufficientEvidence: true,
            }
          : s,
      );

      const rejectionObservation: Observation = {
        stepId: currentStep.id,
        resultText: trimmed,
        recordedAt: new Date().toISOString(),
      };

      const reopened: DiagnosticCase = {
        ...diagnosticCase,
        steps: softenedSteps,
        status: "active",
        confirmedFault: undefined,
        rejectedDiagnoses,
        observations: [...diagnosticCase.observations, rejectionObservation],
      };
      reopened.extracted = refreshExtractedFacts(reopened, trimmed);

      const nextStep = await callVerifiedDiagnosticStep(reopened);
      const isFinish = nextStep.actionType === "FINISH";
      const draftText = [
        nextStep.content,
        nextStep.rationale,
        nextStep.confirmedFault,
      ]
        .filter(Boolean)
        .join("\n");

      const updated: DiagnosticCase = {
        ...reopened,
        steps: [...reopened.steps, nextStep],
        status: isFinish ? "completed" : "active",
        confirmedFault: isFinish ? nextStep.confirmedFault : undefined,
        technicalSpecClaims: mergeTechnicalSpecClaims(reopened, draftText),
        strongVerifierUsed: reopened.strongVerifierUsed,
      };

      return {
        case: updated,
        nextStep,
        message: formatStepMessage(
          nextStep.actionType,
          updated,
          ` (reevaluate after ${isTechnicianRejection(trimmed) ? "rejection" : "continue"})`,
        ),
      };
    }

    const observation: Observation = {
      stepId: currentStep.id,
      resultText: trimmed,
      recordedAt: new Date().toISOString(),
    };

    const caseWithObservation: DiagnosticCase = {
      ...diagnosticCase,
      observations: [...diagnosticCase.observations, observation],
    };
    caseWithObservation.extracted = refreshExtractedFacts(
      caseWithObservation,
      trimmed,
    );

    const nextStep = await callVerifiedDiagnosticStep(caseWithObservation);
    const isFinish = nextStep.actionType === "FINISH";
    const draftText = [
      nextStep.content,
      nextStep.rationale,
      nextStep.confirmedFault,
    ]
      .filter(Boolean)
      .join("\n");

    const updated: DiagnosticCase = {
      ...caseWithObservation,
      steps: [...caseWithObservation.steps, nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish
        ? nextStep.confirmedFault
        : caseWithObservation.confirmedFault,
      technicalSpecClaims: mergeTechnicalSpecClaims(
        caseWithObservation,
        draftText,
      ),
      strongVerifierUsed: caseWithObservation.strongVerifierUsed,
    };

    return {
      case: updated,
      nextStep,
      message: formatStepMessage(nextStep.actionType, updated),
    };
  }
}
