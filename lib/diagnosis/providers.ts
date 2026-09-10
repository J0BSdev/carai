import type { DiagnosticStep } from "./types";

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
};

export type VerifierPayload = {
  approved: boolean;
  issues: string[];
  correctedStep: LlmStepPayload | null;
};

/**
 * Minimal Anthropic structured-output schema for diagnostic steps.
 * No null/anyOf unions (Anthropic limit: 16). Optional fields are omitted, not nullable.
 * Compatible with LlmStepPayload — absent optionals stay undefined.
 */
export const DIAGNOSTIC_STEP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actionType: { type: "string", enum: ["ASK", "TEST", "FINISH"] },
    content: { type: "string" },
    rationale: { type: "string" },
    expectedResultHint: { type: "string" },
    confirmedFault: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    diagnosisConfidence: { type: "number" },
    diagnosisCertainty: {
      type: "string",
      enum: ["SUSPECTED", "LIKELY", "HIGH_CONFIDENCE", "CONFIRMED"],
    },
    insufficientEvidence: { type: "boolean" },
    askDecision: {
      type: "object",
      additionalProperties: false,
      properties: {
        whyNeeded: { type: "string" },
        expectedAnswers: { type: "array", items: { type: "string" } },
        nextStepByAnswer: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              answer: { type: "string" },
              nextAction: { type: "string" },
            },
            required: ["answer", "nextAction"],
          },
        },
      },
      required: ["whyNeeded", "expectedAnswers", "nextStepByAnswer"],
    },
    technicalClaims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string" },
          valueText: { type: "string" },
          sourceType: {
            type: "string",
            enum: [
              "VERIFIED_OEM",
              "VERIFIED_TECHNICAL",
              "GENERAL_PRINCIPLE",
              "MODEL_KNOWLEDGE",
              "UNKNOWN",
            ],
          },
          vehicleSpecific: { type: "boolean" },
        },
        required: ["claim", "sourceType", "vehicleSpecific"],
      },
    },
    safetyPreconditions: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          enum: ["SRS", "HV", "BRAKES", "OTHER_CRITICAL"],
        },
        warnings: { type: "array", items: { type: "string" } },
        requiredSteps: { type: "array", items: { type: "string" } },
        needsVerifiedProcedure: { type: "boolean" },
      },
      required: ["warnings", "requiredSteps", "needsVerifiedProcedure"],
    },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          status: {
            type: "string",
            enum: ["LIKELY", "POSSIBLE", "WEAK", "RULED_OUT", "LEADING"],
          },
          confidence: { type: "number" },
          supportingEvidence: { type: "array", items: { type: "string" } },
          contradictingEvidence: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
        required: ["label", "status"],
      },
    },
  },
  required: ["actionType", "content", "rationale"],
} as const;

/** Models known to support Anthropic output_config.format json_schema. */
function modelSupportsStructuredOutputs(model: string): boolean {
  const m = model.trim().toLowerCase();
  return (
    m.includes("claude-sonnet-5") ||
    m.includes("claude-opus-5") ||
    m.includes("claude-opus-4-8") ||
    m.includes("claude-opus-4-7") ||
    m.includes("claude-opus-4-6") ||
    m.includes("claude-sonnet-4-6") ||
    m.includes("claude-sonnet-4-5") ||
    m.includes("claude-opus-4-5") ||
    m.includes("claude-haiku-4-5") ||
    m.includes("claude-fable-5") ||
    m.includes("claude-mythos")
  );
}

function isDev(): boolean {
  return process.env.NODE_ENV === "development";
}

function logClaudeRaw(label: string, raw: string): void {
  if (!isDev()) return;
  console.error(`[claude-raw:${label}]`, raw.slice(0, 6000));
}

function looksLikeStructuredOutputUnsupported(errText: string): boolean {
  const n = errText.toLowerCase();
  return (
    n.includes("output_config") ||
    n.includes("output_format") ||
    n.includes("json_schema") ||
    n.includes("structured output") ||
    n.includes("union types") ||
    n.includes("too many parameters") ||
    (n.includes("not support") && n.includes("schema"))
  );
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

type AnthropicFetchParams = {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown> | null;
};

async function fetchAnthropicText(
  params: AnthropicFetchParams,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens ?? 2048,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
  };

  if (params.jsonSchema) {
    body.output_config = {
      format: {
        type: "json_schema",
        schema: params.jsonSchema,
      },
    };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": params.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Claude greška (${response.status}): ${errText.slice(0, 400)}`,
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) {
    throw new Error("Claude nije vratio tekstualni odgovor.");
  }
  return text;
}

/**
 * Claude diagnostic call with:
 * 1) structured JSON schema when the model supports it
 * 2) fallback without schema if unsupported
 * 3) at most one cheap JSON-format repair retry (not diagnostic/verifier retry)
 */
export async function callAnthropicJson(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const preferStructured = modelSupportsStructuredOutputs(params.model);
  const schema = DIAGNOSTIC_STEP_JSON_SCHEMA as unknown as Record<
    string,
    unknown
  >;
  let activeSchema: Record<string, unknown> | null = preferStructured
    ? schema
    : null;

  let rawText: string;
  try {
    rawText = await fetchAnthropicText({
      ...params,
      jsonSchema: activeSchema,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (activeSchema && looksLikeStructuredOutputUnsupported(message)) {
      activeSchema = null;
      rawText = await fetchAnthropicText({
        ...params,
        jsonSchema: null,
      });
    } else {
      throw err;
    }
  }

  logClaudeRaw("primary", rawText);
  const parsed = tryParseJsonObject(rawText);
  if (parsed) return parsed;

  // Max 1 JSON-format repair — does not touch verifier / diagnostic retry budget.
  const repairedText = await fetchAnthropicText({
    apiKey: params.apiKey,
    model: params.model,
    maxTokens: Math.min(params.maxTokens ?? 2048, 2048),
    jsonSchema: activeSchema,
    system:
      "You only repair malformed JSON. Return ONLY a valid JSON object. No markdown, no commentary.",
    user: [
      "The previous assistant reply was not valid JSON.",
      "Repair it into ONE valid JSON object with the diagnostic step fields",
      "(actionType, content, rationale, and related nullable fields).",
      "Do not change diagnostic meaning; only fix JSON syntax/structure.",
      "",
      "Malformed reply:",
      rawText.slice(0, 12000),
    ].join("\n"),
  });

  logClaudeRaw("json-repair", repairedText);
  const repaired = tryParseJsonObject(repairedText);
  if (repaired) return repaired;

  throw new Error(
    "Claude dijagnostički odgovor nije valjani JSON (ni nakon 1 JSON-format retryja).",
  );
}

export async function callOpenAiJson(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
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
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("OpenAI nije vratio sadržaj odgovora.");
  }
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

/** Narrow helper for typing step-shaped objects after verification. */
export type DraftStepFields = Pick<
  DiagnosticStep,
  | "actionType"
  | "content"
  | "rationale"
  | "expectedResultHint"
  | "confirmedFault"
  | "confidence"
  | "insufficientEvidence"
  | "facts"
  | "evidence"
  | "hypotheses"
>;
