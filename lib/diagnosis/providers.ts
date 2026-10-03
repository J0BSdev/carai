import { recordAiCall, logAnthropicJsonEnvelope, type AiCallMeta, type AiTokenUsage } from "./ai-telemetry";
import { AI_REQUEST_TIMEOUT_MS } from "./config";
import { DiagnosticPipelineError } from "./errors";
import type {
  AiActionType,
  DiagnosisCertainty,
  Hypothesis,
  TechnicalSourceType,
  TechnicianOutcome,
} from "./types";

/** Already validated by parseDiagnosticDraft. Measurements are raw strings. */
export type SemanticUpdate = {
  vehicle?: {
    make?: string;
    model?: string;
    year?: number;
    engine?: string;
    mileage?: number;
  };
  symptomsAdd?: string[];
  symptomsRemove?: string[];
  dtcsAdd?: string[];
  measurementsAdd?: string[];
  technicianOutcome?: TechnicianOutcome;
};

export type LlmStepPayload = {
  actionType: AiActionType;
  content: string;
  rationale: string;
  expectedResultHint?: string;
  confirmedFault?: string;
  diagnosisCertainty?: DiagnosisCertainty;
  semanticUpdate?: SemanticUpdate;
  technicalClaims?: Array<{
    claim: string;
    valueText?: string;
    sourceType: TechnicalSourceType;
    vehicleSpecific?: boolean;
  }>;
  hypotheses?: Hypothesis[];
  /** Optional short how-to for a non-routine TEST. */
  testGuide?: string;
};

export type VerifierPayload = {
  approved: boolean;
  issues: string[];
};

type AnthropicResult = {
  text: string;
  usage: AiTokenUsage;
  latencyMs: number;
  stopReason: string | null;
};

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DiagnosticPipelineError(
        `AI poziv prekinut nakon ${AI_REQUEST_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": params.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "extended-cache-ttl-2025-04-11",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 2048,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: [
        {
          type: "text",
          text: params.system,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
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
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
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
  const cacheCreationInputTokens =
    typeof data.usage?.cache_creation_input_tokens === "number"
      ? data.usage.cache_creation_input_tokens
      : null;
  const cacheReadInputTokens =
    typeof data.usage?.cache_read_input_tokens === "number"
      ? data.usage.cache_read_input_tokens
      : null;
  const usage: AiTokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens != null && outputTokens != null
        ? inputTokens + outputTokens
        : null,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cacheTtl: "1h",
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
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheTtl: usage.cacheTtl,
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
  logAnthropicJsonEnvelope({
    rawText: primary.text,
    extractedJson: extractJsonObject(primary.text),
    stopReason: primary.stopReason,
    outputTokens: primary.usage.outputTokens,
  });

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
  const response = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
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
