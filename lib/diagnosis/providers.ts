import type { DiagnosticStep } from "./types";

export type LlmStepPayload = {
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

export async function callAnthropicJson(params: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
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
      temperature: 0.3,
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
  };
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) {
    throw new Error("Claude nije vratio tekstualni odgovor.");
  }
  return extractJsonObject(text);
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
      temperature: 0.2,
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
