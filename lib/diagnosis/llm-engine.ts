import {
  DIAGNOSTIC_SYSTEM_PROMPT,
  buildDiagnosticUserPrompt,
} from "./prompts";
import type {
  AiActionType,
  DiagnosticCase,
  DiagnosticStep,
  DiagnoseResponse,
  Hypothesis,
  Observation,
} from "./types";
import type { DiagnosticEngine } from "./engine";

type LlmStepPayload = {
  actionType: string;
  content: string;
  rationale: string;
  expectedResultHint?: string | null;
  confirmedFault?: string | null;
  confidence?: "low" | "medium" | "high" | null;
  insufficientEvidence?: boolean | null;
  facts?: string[] | null;
  evidence?: string[] | null;
  hypotheses?: Array<{
    label: string;
    status: string;
    note?: string | null;
  }> | null;
};

const ALLOWED_ACTIONS: AiActionType[] = ["ASK", "TEST", "FINISH"];

function getApiKey(): string {
  const key =
    process.env.OPENAI_API_KEY?.trim() || process.env.AI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Nedostaje OPENAI_API_KEY (ili AI_API_KEY). Postavi ga u .env.local.",
    );
  }
  return key;
}

function getModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

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
      status: (allowed.has(h.status) ? h.status : "plausible") as Hypothesis["status"],
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

async function callOpenAiForStep(
  diagnosticCase: DiagnosticCase,
): Promise<DiagnosticStep> {
  const apiKey = getApiKey();
  const model = getModel();

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DIAGNOSTIC_SYSTEM_PROMPT },
        { role: "user", content: buildDiagnosticUserPrompt(diagnosticCase) },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `OpenAI greška (${response.status}): ${errText.slice(0, 400)}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("OpenAI nije vratio sadržaj odgovora.");
  }

  let parsed: LlmStepPayload;
  try {
    parsed = JSON.parse(raw) as LlmStepPayload;
  } catch {
    throw new Error("OpenAI odgovor nije valjani JSON.");
  }

  const stepId = `step-${diagnosticCase.steps.length + 1}`;
  return toDiagnosticStep(parsed, stepId);
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

    const nextStep = await callOpenAiForStep(baseCase);
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
      message: `AI: ${nextStep.actionType}`,
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

    const nextStep = await callOpenAiForStep(caseWithObservation);
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
      message: `AI: ${nextStep.actionType}`,
    };
  }
}
