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

function parseHypotheses(
  value: LlmStepPayload["hypotheses"],
): Hypothesis[] | undefined {
  if (!value || !Array.isArray(value)) return undefined;
  const allowed = new Set([
    "plausible",
    "weakened",
    "ruled_out",
    "supported",
  ]);
  return value
    .filter((h) => h && typeof h.label === "string")
    .map((h) => ({
      label: h.label,
      status: (allowed.has(h.status)
        ? h.status
        : "plausible") as Hypothesis["status"],
      note: h.note ?? undefined,
    }));
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
 * 2) OpenAI (VERIFIER_MODEL) approves, corrects, or rejects.
 * 3) On reject without correction, Claude retries once with verifier issues.
 */
async function callVerifiedDiagnosticStep(
  diagnosticCase: DiagnosticCase,
): Promise<DiagnosticStep> {
  const stepId = `step-${diagnosticCase.steps.length + 1}`;

  let draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticUserPrompt(diagnosticCase),
  );

  let verdict = await verifyWithOpenAi(diagnosticCase, draft);

  if (!verdict.approved && verdict.correctedStep) {
    draft = verdict.correctedStep;
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
    verdict = await verifyWithOpenAi(diagnosticCase, draft);
    if (!verdict.approved && verdict.correctedStep) {
      draft = verdict.correctedStep;
    } else if (!verdict.approved) {
      throw new Error(
        `Verifier je odbio korak: ${verdict.issues.join("; ") || "nepoznat razlog"}`,
      );
    }
  }

  return toDiagnosticStep(draft, stepId);
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
