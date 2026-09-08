/**
 * Model roles (product contracts):
 *
 * DIAGNOSTIC_MODEL (Claude) — primary diagnostician.
 *   Sees the full case history and chooses exactly one next action:
 *   ASK | TEST | FINISH. Owns diagnostic quality and step content.
 *
 * VERIFIER_MODEL (OpenAI) — safety / quality gate.
 *   Reviews the draft step before it reaches the mechanic.
 *   Rejects invented specs, multi-cause dumps, premature FINISH,
 *   repeated questions/tests, and missing single-action focus.
 *   May return a corrected step or force one diagnostic retry.
 */

const MODEL_ALIASES: Record<string, string> = {
  // Cursor-style / shorthand → provider API ids
  "claude-sonnet-5": "claude-sonnet-4-5",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "gpt-5.6-terra": "gpt-4.1",
  "gpt-5.6": "gpt-4.1",
};

function resolveModelId(raw: string): string {
  const key = raw.trim();
  return MODEL_ALIASES[key] ?? MODEL_ALIASES[key.toLowerCase()] ?? key;
}

export function getClaudeApiKey(): string | undefined {
  return (
    process.env.CLAUDE_API_KEY?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim() ||
    undefined
  );
}

export function getOpenAiApiKey(): string | undefined {
  return (
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.AI_API_KEY?.trim() ||
    undefined
  );
}

/** Primary diagnostician (Claude). */
export function getDiagnosticModel(): string {
  const raw =
    process.env.DIAGNOSTIC_MODEL?.trim() || "claude-sonnet-4-5";
  return resolveModelId(raw);
}

/** Verifier / safety gate (OpenAI). */
export function getVerifierModel(): string {
  const raw = process.env.VERIFIER_MODEL?.trim() || "gpt-4.1";
  return resolveModelId(raw);
}

export function hasLlmConfigured(): boolean {
  // Need Claude for diagnosis; OpenAI for verifier. Both required for dual-model path.
  return Boolean(getClaudeApiKey() && getOpenAiApiKey());
}
