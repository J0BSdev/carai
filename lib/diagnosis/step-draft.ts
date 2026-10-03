import type { LlmStepPayload } from "./providers";
import {
  mapHypothesisUiStatus,
  resolveDiagnosisCertainty,
} from "./confirmation-guard";
import type {
  AiActionType,
  DiagnosisCertainty,
  DiagnosticStep,
  Hypothesis,
} from "./types";

const ALLOWED_ACTIONS: AiActionType[] = ["ASK", "TEST", "FINISH"];

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
      confidence,
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

export function toDiagnosticStep(
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
  let diagnosisConfidence = parseDiagnosisConfidence(payload.diagnosisConfidence);

  if (actionType === "FINISH") {
    diagnosisCertainty = resolveDiagnosisCertainty(payload);
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
    diagnosisCertainty,
    diagnosisConfidence,
    facts: payload.facts ?? undefined,
    evidence: payload.evidence ?? undefined,
    hypotheses: parseHypotheses(payload.hypotheses),
    diagnosticTarget:
      actionType === "TEST"
        ? payload.diagnosticTarget?.trim() || undefined
        : undefined,
    diagnosticGoal:
      actionType === "TEST"
        ? payload.diagnosticGoal?.trim() || undefined
        : undefined,
    testMethod:
      actionType === "TEST"
        ? payload.testMethod?.trim() || undefined
        : undefined,
    testGuide:
      actionType === "TEST"
        ? payload.testGuide?.trim() || undefined
        : undefined,
  };
}


