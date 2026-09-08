import {
  getClaudeApiKey,
  getDiagnosticModel,
  getOpenAiApiKey,
  getVerifierModel,
} from "./config";
import type { DiagnosticEngine } from "./engine";
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
import type {
  AiActionType,
  DiagnosticCase,
  DiagnosticStep,
  DiagnoseResponse,
  Hypothesis,
  Observation,
} from "./types";

const ALLOWED_ACTIONS: AiActionType[] = ["ASK", "TEST", "FINISH"];

function normalizeHypothesisStatus(status: string): Hypothesis["status"] {
  const key = status.trim().toUpperCase().replace(/[\s-]+/g, "_");
  switch (key) {
    case "LEADING":
    case "SUPPORTED":
      return "supported";
    case "POSSIBLE":
    case "PLAUSIBLE":
      return "plausible";
    case "WEAK":
    case "WEAKENED":
      return "weakened";
    case "RULED_OUT":
      return "ruled_out";
    default:
      return "plausible";
  }
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
      status: normalizeHypothesisStatus(h.status ?? "POSSIBLE"),
      note: h.note ?? undefined,
      confidence,
      supportingEvidence: h.supportingEvidence?.filter(Boolean),
      contradictingEvidence: h.contradictingEvidence?.filter(Boolean),
    });
  }
  return parsed.length > 0 ? parsed : undefined;
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
    insufficientEvidence: payload.insufficientEvidence ?? undefined,
    facts: payload.facts ?? undefined,
    evidence: payload.evidence ?? undefined,
    hypotheses: parseHypotheses(payload.hypotheses),
  };
}

async function draftWithClaude(
  diagnosticCase: DiagnosticCase,
  userPrompt: string,
): Promise<LlmStepPayload> {
  const apiKey = getClaudeApiKey();
  if (!apiKey) {
    throw new Error("Nedostaje CLAUDE_API_KEY. Postavi ga u .env.");
  }

  const raw = await callAnthropicJson({
    apiKey,
    model: getDiagnosticModel(),
    system: DIAGNOSTIC_SYSTEM_PROMPT,
    user: userPrompt,
  });

  return parseJson<LlmStepPayload>(raw, "Claude dijagnostički odgovor");
}

async function verifyWithOpenAi(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): Promise<VerifierPayload> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("Nedostaje OPENAI_API_KEY. Postavi ga u .env.");
  }

  const raw = await callOpenAiJson({
    apiKey,
    model: getVerifierModel(),
    system: VERIFIER_SYSTEM_PROMPT,
    user: buildVerifierUserPrompt(diagnosticCase, draft),
  });

  const parsed = parseJson<VerifierPayload>(raw, "OpenAI verifier odgovor");
  return {
    approved: Boolean(parsed.approved),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    correctedStep: parsed.correctedStep ?? null,
  };
}

/**
 * Dual-model pipeline:
 * 1) Claude (DIAGNOSTIC_MODEL) proposes the next ASK/TEST/FINISH step.
 * 2) Programmatic guard rejects repeats, similar-test branches, low-value ASKs.
 * 3) OpenAI (VERIFIER_MODEL) approves, corrects, or rejects.
 * 4) On reject without correction, Claude retries with verifier issues.
 */
async function callVerifiedDiagnosticStep(
  diagnosticCase: DiagnosticCase,
): Promise<DiagnosticStep> {
  const stepId = `step-${diagnosticCase.steps.length + 1}`;

  let draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticUserPrompt(diagnosticCase),
  );

  draft = await ensureDraftPassesQualityGates(diagnosticCase, draft);

  let verdict = await verifyWithOpenAi(diagnosticCase, draft);

  if (!verdict.approved && verdict.correctedStep) {
    const correctedIssue = findDraftQualityIssue(
      diagnosticCase,
      verdict.correctedStep,
    );
    if (correctedIssue) {
      draft = await ensureDraftPassesQualityGates(
        diagnosticCase,
        verdict.correctedStep,
        [
          correctedIssue,
          "Predloži drugačiji korak bez ponavljanja iste dijagnostičke grane.",
        ],
      );
    } else {
      draft = verdict.correctedStep;
    }
  } else if (!verdict.approved) {
    draft = await draftWithClaude(
      diagnosticCase,
      buildDiagnosticRetryPrompt(
        diagnosticCase,
        draft,
        verdict.issues.length
          ? verdict.issues
          : ["Draft nije odobren; predloži ispravan jedan korak."],
      ),
    );
    draft = await ensureDraftPassesQualityGates(diagnosticCase, draft);
    verdict = await verifyWithOpenAi(diagnosticCase, draft);
    if (!verdict.approved && verdict.correctedStep) {
      const correctedIssue = findDraftQualityIssue(
        diagnosticCase,
        verdict.correctedStep,
      );
      if (correctedIssue) {
        draft = await ensureDraftPassesQualityGates(
          diagnosticCase,
          verdict.correctedStep,
          [correctedIssue],
        );
      } else {
        draft = verdict.correctedStep;
      }
    } else if (!verdict.approved) {
      throw new Error(
        `Verifier je odbio korak: ${verdict.issues.join("; ") || "nepoznat razlog"}`,
      );
    }
  }

  return toDiagnosticStep(draft, stepId);
}

async function ensureDraftPassesQualityGates(
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
  extraIssues: string[] = [],
): Promise<LlmStepPayload> {
  let draft = initialDraft;
  let issue = findDraftQualityIssue(diagnosticCase, draft);
  if (!issue && extraIssues.length === 0) return draft;

  const firstIssues = [
    ...(issue ? [issue] : []),
    ...extraIssues,
    "Predloži DRUGAČIJI sljedeći korak koristeći CASE STATE.",
    "Ne ponavljaj već postavljena pitanja ni završene/semantički slične testove.",
    "Ako ASK nema decision value → TEST. Ako TEST ne razlikuje hipoteze → bolji TEST ili FINISH.",
    "Skipped test nije dokaz — ne parafraziraj ga.",
  ];

  draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticRetryPrompt(diagnosticCase, draft, firstIssues),
  );
  issue = findDraftQualityIssue(diagnosticCase, draft);
  if (!issue) return draft;

  draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticRetryPrompt(diagnosticCase, draft, [
      issue,
      "OBAVEZNO: vrati akciju iz DRUGE dijagnostičke grane ILI FINISH.",
      "Zabranjeno: isti dio + ista vrsta mjerenja kao completedTests/skippedUnavailableTests.",
      "Ako completedTests već snažno podupiru LEADING hipotezu → FINISH s confirmedFault.",
      "Inače: jedan TEST koji razlikuje LEADING od najjače alternative (druga metoda/točka/sustav).",
      "U rationale navedi koje hipoteze razlikuješ.",
    ]),
  );
  issue = findDraftQualityIssue(diagnosticCase, draft);
  if (!issue) return draft;

  // Last resort: stop checklist loops — force FINISH from evidence rather than hard-failing the case.
  draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticRetryPrompt(diagnosticCase, draft, [
      issue,
      "ZADNJI POKUŠAJ: actionType MORA biti FINISH.",
      "Sažmi vodeću hipotezu iz CASE STATE (completedTests + answers).",
      "Nemoj predlagati novi TEST.",
      "Ako dokaz nije potpun, stavi insufficientEvidence: true i objasni što nedostaje.",
      "skippedUnavailableTests nisu dokaz.",
    ]),
  );
  if (draft.actionType !== "FINISH") {
    draft = {
      ...draft,
      actionType: "FINISH",
      content:
        draft.content?.trim() ||
        "Na temelju prikupljenih dokaza vodeća dijagnoza je najvjerojatniji uzrok; dodatni slični testovi ne bi dali novu informaciju.",
      rationale:
        draft.rationale?.trim() ||
        "Dodatni semantički slični testovi ne mijenjaju ranking hipoteza — završavam na temelju postojećih dokaza.",
      insufficientEvidence: draft.insufficientEvidence ?? true,
      confirmedFault:
        draft.confirmedFault ??
        "Vodeća hipoteza prema dostupnim dokazima (provjeri insufficientEvidence).",
    };
  }
  issue = findDraftQualityIssue(diagnosticCase, draft);
  if (issue && draft.actionType !== "FINISH") {
    throw new Error(`AI draft odbijen: ${issue}. Pokušaj ponovno.`);
  }
  return draft;
}

function lightExtract(problemText: string): DiagnosticCase["extracted"] {
  const dtcMatches = problemText.toUpperCase().match(/P[0-9A-F]{4}/g);
  return {
    symptoms: [problemText.trim()],
    dtcs: dtcMatches ? [...new Set(dtcMatches)] : undefined,
  };
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

    const diagnosticCase: DiagnosticCase = {
      ...baseCase,
      steps: [nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish ? nextStep.confirmedFault : undefined,
    };

    return {
      case: diagnosticCase,
      nextStep,
      message: `AI (${getDiagnosticModel()} + verifier ${getVerifierModel()}): ${nextStep.actionType}`,
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

    if (diagnosticCase.status === "completed") {
      return {
        case: diagnosticCase,
        nextStep: null,
        message: "Slučaj je već završen.",
      };
    }

    const currentStep = diagnosticCase.steps[diagnosticCase.steps.length - 1];
    if (!currentStep) {
      throw new Error("Slučaj nema aktivni korak za zabilježiti");
    }

    if (currentStep.actionType === "FINISH") {
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

    const observation: Observation = {
      stepId: currentStep.id,
      resultText: trimmed,
      recordedAt: new Date().toISOString(),
    };

    const caseWithObservation: DiagnosticCase = {
      ...diagnosticCase,
      observations: [...diagnosticCase.observations, observation],
    };

    const nextStep = await callVerifiedDiagnosticStep(caseWithObservation);
    const isFinish = nextStep.actionType === "FINISH";

    const updated: DiagnosticCase = {
      ...caseWithObservation,
      steps: [...caseWithObservation.steps, nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish
        ? nextStep.confirmedFault
        : caseWithObservation.confirmedFault,
    };

    return {
      case: updated,
      nextStep,
      message: `AI (${getDiagnosticModel()} + verifier ${getVerifierModel()}): ${nextStep.actionType}`,
    };
  }
}
