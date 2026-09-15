import { recordAiCall, type AiCallMeta, type AiTokenUsage } from "./ai-telemetry";

export type LlmStepPayload = {
  actionType: string;
  content: string;
  rationale: string;
  expectedResultHint?: string | null;
  confirmedFault?: string | null;
  confidence?: "low" | "medium" | "high" | null;
  /** 0–100 evidence ranking for leading diagnosis; not statistical probability. */
  diagnosisConfidence?: number | null;
  diagnosisCertainty?: string | null;
  insufficientEvidence?: boolean | null;
  facts?: string[] | null;
  evidence?: string[] | null;
  /**
   * Explicit semantic case-fact delta from the diagnostic model (same Claude call).
   * The model is the only semantic extractor for vehicle/symptoms/DTCs/measurements;
   * the backend just validates types, dedupes and merges. Never evidence authority —
   * guards still decide what counts as evidence, skipped/ambiguous, CONFIRMED, safety.
   */
  semanticUpdate?: {
    vehicle?: {
      make?: string | null;
      model?: string | null;
      year?: number | string | null;
      engine?: string | null;
      mileage?: number | null;
    } | null;
    symptomsAdd?: string[] | null;
    symptomsRemove?: string[] | null;
    /** Fault codes exactly as stated by the mechanic — backend never invents a namespace. */
    dtcsAdd?: string[] | null;
    /** Explicit numeric readings the mechanic reported. */
    measurementsAdd?: Array<{
      raw?: string | null;
      value?: number | string | null;
      unit?: string | null;
      parameter?: string | null;
    }> | null;
  } | null;
  /**
   * Required for ASK: decision-critical justification.
   * Backend rejects ASK without this (or equivalent branch proof in rationale).
   */
  askDecision?: {
    whyNeeded?: string | null;
    expectedAnswers?: string[] | null;
    nextStepByAnswer?: Array<{
      answer?: string;
      nextAction?: string;
    }> | null;
  } | null;
  /** Technical claims/specs with mandatory sourceType honesty. */
  technicalClaims?: Array<{
    claim?: string | null;
    valueText?: string | null;
    sourceType?: string | null;
    vehicleSpecific?: boolean | null;
  }> | null;
  /** Mandatory for safety-critical TESTs (SRS/HV/brakes…). */
  safetyPreconditions?: {
    category?: string | null;
    warnings?: string[] | null;
    requiredSteps?: string[] | null;
    needsVerifiedProcedure?: boolean | null;
  } | null;
  hypotheses?: Array<{
    label?: string;
    cause?: string;
    status: string;
    note?: string | null;
    confidence?: number | null;
    supportingEvidence?: string[] | null;
    contradictingEvidence?: string[] | null;
  }> | null;
  /** TEST branch metadata — required for new TEST drafts. */
  diagnosticTarget?: string | null;
  diagnosticGoal?: string | null;
  testMethod?: string | null;
};

export type VerifierPayload = {
  approved: boolean;
  issues: string[];
  correctedStep: LlmStepPayload | null;
};

type AnthropicResult = {
  text: string;
  usage: AiTokenUsage;
  latencyMs: number;
  stopReason: string | null;
};

function tryParseJsonObject(raw: string): string | null {
  const extracted = extractJsonObject(raw);
  try {
    JSON.parse(extracted);
    return extracted;
  } catch {
    return null;
  }
}

/** Plain Claude Messages call: model + max_tokens + system + messages (no temperature). */
async function fetchAnthropicText(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<AnthropicResult> {
  const started = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": params.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 2048,
      system: params.system,
      messages: [{ role: "user", content: params.user }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Claude greška (${response.status}): ${errText.slice(0, 400)}`,
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  const latencyMs = Date.now() - started;
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) {
    throw new Error("Claude nije vratio tekstualni odgovor.");
  }

  const inputTokens =
    typeof data.usage?.input_tokens === "number"
      ? data.usage.input_tokens
      : null;
  const outputTokens =
    typeof data.usage?.output_tokens === "number"
      ? data.usage.output_tokens
      : null;
  const usage: AiTokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens != null && outputTokens != null
        ? inputTokens + outputTokens
        : null,
  };

  return {
    text,
    usage,
    latencyMs,
    stopReason: data.stop_reason ?? null,
  };
}

function emitCall(
  meta: AiCallMeta | undefined,
  provider: "anthropic" | "openai",
  model: string,
  usage: AiTokenUsage,
  latencyMs: number,
  finishReason?: string | null,
): void {
  if (!meta) return;
  recordAiCall({
    caseId: meta.caseId,
    stepId: meta.stepId,
    stepNumber: meta.stepNumber,
    provider,
    role: meta.role,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    latencyMs,
    retryNumber: meta.retryNumber,
    reasonCalled: meta.reasonCalled,
    finishReason: finishReason ?? null,
  });
}

/** Claude diagnostic call (plain text JSON). No format-repair retries. */
export async function callAnthropicJson(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  telemetry?: AiCallMeta;
}): Promise<string> {
  const primary = await fetchAnthropicText(params);
  emitCall(
    params.telemetry,
    "anthropic",
    params.model,
    primary.usage,
    primary.latencyMs,
    primary.stopReason,
  );

  if (primary.stopReason === "max_tokens") {
    throw new Error(
      "Claude odgovor prekinut (finishReason=max_tokens); JSON je vjerojatno nepotpun.",
    );
  }

  const parsed = tryParseJsonObject(primary.text);
  if (parsed) return parsed;

  throw new Error("Claude dijagnostički odgovor nije valjani JSON.");
}

export async function callOpenAiJson(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  telemetry?: AiCallMeta;
}): Promise<string> {
  const started = Date.now();
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
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
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string | null;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const latencyMs = Date.now() - started;
  const choice = data.choices?.[0];
  const raw = choice?.message?.content;
  if (!raw) {
    throw new Error("OpenAI nije vratio sadržaj odgovora.");
  }

  const inputTokens =
    typeof data.usage?.prompt_tokens === "number"
      ? data.usage.prompt_tokens
      : null;
  const outputTokens =
    typeof data.usage?.completion_tokens === "number"
      ? data.usage.completion_tokens
      : null;
  const totalTokens =
    typeof data.usage?.total_tokens === "number"
      ? data.usage.total_tokens
      : inputTokens != null && outputTokens != null
        ? inputTokens + outputTokens
        : null;

  const finishReasonRaw = choice?.finish_reason ?? null;
  const finishReason =
    finishReasonRaw === "length" ? "max_tokens" : finishReasonRaw;
  emitCall(
    params.telemetry,
    "openai",
    params.model,
    { inputTokens, outputTokens, totalTokens },
    latencyMs,
    finishReason,
  );

  return extractJsonObject(raw);
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label} nije valjani JSON.`);
  }
}
