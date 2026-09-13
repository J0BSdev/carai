/**
 * Dev-only AI call telemetry (tokens, latency, cost).
 * Does not log API keys, prompts, or raw model responses.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type AiCallRole =
  | "diagnostic"
  | "diagnostic_retry"
  | "verifier"
  | "strong_verifier"
  | "json_repair";

export type AiProvider = "anthropic" | "openai";

export type AiTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type AiCallRecord = {
  caseId: string;
  stepId: string;
  stepNumber: number;
  provider: AiProvider;
  role: AiCallRole;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Network/API round-trip for this call. */
  latencyMs: number;
  retryNumber: number;
  estimatedCost: number | null;
  reasonCalled: string;
};

export type AiCallMeta = {
  caseId: string;
  stepId: string;
  stepNumber: number;
  role: AiCallRole;
  reasonCalled: string;
  retryNumber: number;
};

type StepAccumulator = {
  caseId: string;
  stepId: string;
  stepNumber: number;
  turnStartedAt: number;
  calls: AiCallRecord[];
};

type CaseAccumulator = {
  caseId: string;
  steps: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  /** Sum of per-call API latencies. */
  apiLatencyMs: number;
  /** Sum of wall-clock turn latencies. */
  turnLatencyMs: number;
};

const caseTotals = new Map<string, CaseAccumulator>();
const stepStore = new AsyncLocalStorage<StepAccumulator>();

function isDev(): boolean {
  return process.env.NODE_ENV === "development";
}

function logLine(message: string): void {
  if (!isDev()) return;
  console.info(message);
}

/** Rough USD estimates when provider usage is known. */
export function estimateCostUsd(
  provider: AiProvider,
  model: string,
  usage: AiTokenUsage,
): number | null {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (input == null || output == null) return null;

  const rates = pricingForModel(provider, model);
  if (!rates) return null;
  return (input * rates.inPerM + output * rates.outPerM) / 1_000_000;
}

function pricingForModel(
  provider: AiProvider,
  model: string,
): { inPerM: number; outPerM: number } | null {
  const m = model.toLowerCase();
  if (provider === "anthropic") {
    if (m.includes("haiku")) return { inPerM: 1, outPerM: 5 };
    if (m.includes("opus")) return { inPerM: 15, outPerM: 75 };
    // sonnet / default Claude
    return { inPerM: 3, outPerM: 15 };
  }
  // OpenAI verifier models
  if (m.includes("gpt-4o-mini") || m.includes("mini")) {
    return { inPerM: 0.15, outPerM: 0.6 };
  }
  if (m.includes("gpt-4.1") || m.includes("gpt-4o") || m.includes("gpt-5")) {
    return { inPerM: 2, outPerM: 8 };
  }
  return { inPerM: 2, outPerM: 8 };
}

export function formatCost(cost: number | null): string {
  if (cost == null || Number.isNaN(cost)) return "?";
  if (cost < 0.0001) return `$${cost.toFixed(6)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

/**
 * Map a backend guard issue string to a short guard id for retry logs.
 */
export function classifyGuardName(issue: string | null | undefined): string {
  if (!issue) return "unknown";
  const t = issue.toUpperCase();
  if (/REASONING|CONSISTENCY/.test(t)) return "reasoning_consistency";
  if (/ALREADY KNOWN|KNOWN FACT|VEĆ POZNAT|PITANJE VEĆ/.test(t)) {
    return "known_facts";
  }
  if (/ASK DECISION|DECISION.?VALUE|CANDIDATEQUESTION/.test(t)) {
    return "ask_decision_gate";
  }
  if (/SAFETY REJECT|SAFETY /.test(t)) return "safety_guard";
  if (/UNVERIFIED SPEC|SPEC LOCK|SPEC GUARD|FINISH GUARD/.test(t)) {
    return "spec_guard";
  }
  if (/CONFIRMED|CONFIRMATION|INSUFFICIENT EVIDENCE/.test(t)) {
    return "confirmation_guard";
  }
  if (/PONAVL|REPETITION|VEĆ IMA ODGOVOR|VEĆ POSTAVLJEN/.test(t)) {
    return "repetition";
  }
  if (/SEMANTIČKI|SEMANTICKI|ISTA GRAN|SIMILAR TEST|SKIPPED/.test(t)) {
    return "similar_test_branch";
  }
  if (/TEST PRIORITY/.test(t)) return "test_priority";
  if (/HIPOTEZ|HYPOTHESIS|RAZLIKUJ/.test(t)) return "hypothesis_diff";
  if (/VERIFIER/.test(t)) return "verifier";
  return "quality_gate";
}

export async function runAiStep<T>(
  params: { caseId: string; stepId: string; stepNumber: number },
  fn: () => Promise<T>,
): Promise<T> {
  const step: StepAccumulator = {
    caseId: params.caseId,
    stepId: params.stepId,
    stepNumber: params.stepNumber,
    turnStartedAt: Date.now(),
    calls: [],
  };

  try {
    return await stepStore.run(step, fn);
  } finally {
    endAiStep(step);
  }
}

export function getActiveAiStep(): StepAccumulator | null {
  return stepStore.getStore() ?? null;
}

export function recordAiCall(
  partial: Omit<AiCallRecord, "estimatedCost"> & {
    estimatedCost?: number | null;
  },
): AiCallRecord {
  const usage: AiTokenUsage = {
    inputTokens: partial.inputTokens,
    outputTokens: partial.outputTokens,
    totalTokens: partial.totalTokens,
  };
  const estimatedCost =
    partial.estimatedCost !== undefined
      ? partial.estimatedCost
      : estimateCostUsd(partial.provider, partial.model, usage);

  const record: AiCallRecord = {
    ...partial,
    estimatedCost,
  };

  const step = stepStore.getStore();
  if (step && step.stepId === record.stepId) {
    step.calls.push(record);
  }

  logAiCall(record);
  return record;
}

function logAiCall(record: AiCallRecord): void {
  const parts = [`[AI] step=${record.stepNumber}`, `role=${record.role}`];
  if (record.role !== "diagnostic" || record.reasonCalled !== "initial") {
    parts.push(`reason=${record.reasonCalled}`);
  }
  parts.push(
    `model=${record.model}`,
    `in=${record.inputTokens ?? "?"}`,
    `out=${record.outputTokens ?? "?"}`,
    `cost=${formatCost(record.estimatedCost)}`,
    `latency=${record.latencyMs}ms`,
  );
  if (record.retryNumber > 0) {
    parts.push(`retry=${record.retryNumber}`);
  }
  logLine(parts.join(" "));
}

/** Log which backend guard triggered a diagnostic retry (no prompt/issue dump). */
export function logGuardRetry(params: {
  stepNumber: number;
  guard: string;
  retryNumber: number;
  issueSummary?: string;
}): void {
  const summary = params.issueSummary
    ? ` detail=${truncate(params.issueSummary, 80)}`
    : "";
  logLine(
    `[AI] step=${params.stepNumber} guard_retry guard=${params.guard} retry=${params.retryNumber}${summary}`,
  );
}

/** Log JSON parse failure reason without raw response body. */
export function logJsonParseFail(params: {
  stepNumber: number;
  reason: string;
}): void {
  logLine(
    `[AI] step=${params.stepNumber} role=json_repair parse_fail reason=${truncate(params.reason, 120)}`,
  );
}

function endAiStep(step: StepAccumulator): void {
  const turnLatencyMs = Date.now() - step.turnStartedAt;
  const apiLatencyMs = step.calls.reduce((s, c) => s + c.latencyMs, 0);
  const inputTokens = sumNullable(step.calls.map((c) => c.inputTokens));
  const outputTokens = sumNullable(step.calls.map((c) => c.outputTokens));
  const totalTokens =
    sumNullable(step.calls.map((c) => c.totalTokens)) ??
    (inputTokens != null && outputTokens != null
      ? inputTokens + outputTokens
      : null);
  const cost = sumCosts(step.calls);

  logLine(
    `[AI] STEP TOTAL calls=${step.calls.length} tokens=${totalTokens ?? "?"} cost=${formatCost(cost)} latency=${turnLatencyMs}ms (api=${apiLatencyMs}ms turn=${turnLatencyMs}ms)`,
  );

  const prev = caseTotals.get(step.caseId) ?? {
    caseId: step.caseId,
    steps: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    apiLatencyMs: 0,
    turnLatencyMs: 0,
  };

  prev.steps += 1;
  prev.calls += step.calls.length;
  prev.inputTokens += inputTokens ?? 0;
  prev.outputTokens += outputTokens ?? 0;
  prev.totalTokens += totalTokens ?? 0;
  prev.estimatedCost += cost ?? 0;
  prev.apiLatencyMs += apiLatencyMs;
  prev.turnLatencyMs += turnLatencyMs;
  caseTotals.set(step.caseId, prev);

  logLine(
    `[AI] CASE TOTAL case=${shortId(step.caseId)} steps=${prev.steps} calls=${prev.calls} tokens=${prev.totalTokens || "?"} cost=${formatCost(prev.estimatedCost)} latency=${prev.turnLatencyMs}ms (api=${prev.apiLatencyMs}ms turn=${prev.turnLatencyMs}ms)`,
  );
}

function sumNullable(values: Array<number | null>): number | null {
  let any = false;
  let sum = 0;
  for (const v of values) {
    if (v == null) continue;
    any = true;
    sum += v;
  }
  return any ? sum : null;
}

function sumCosts(calls: AiCallRecord[]): number | null {
  let any = false;
  let sum = 0;
  for (const c of calls) {
    if (c.estimatedCost == null) continue;
    any = true;
    sum += c.estimatedCost;
  }
  return any ? sum : null;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function describeJsonParseFailure(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "empty_response";
  if (trimmed.startsWith("```")) return "markdown_fenced_not_plain_json";
  if (!trimmed.includes("{")) return "no_json_object_found";
  try {
    JSON.parse(
      trimmed.startsWith("{") ? trimmed : extractLikelyObject(trimmed),
    );
    return "unknown_parse_failure";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `json_parse_error: ${msg}`;
  }
}

function extractLikelyObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
