/**
 * Model roles (product contracts):
 *
 * DIAGNOSTIC_MODEL (Claude) — primary diagnostician.
 * VERIFIER_MODEL (OpenAI) — selective primary safety / quality gate.
 * STRONG_VERIFIER_MODEL (OpenAI) — rare escalation gate (max 1× per case).
 *
 * Values come from env as-is (provider / platform model IDs).
 */

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

/** Primary diagnostician (Claude). Env: DIAGNOSTIC_MODEL */
export function getDiagnosticModel(): string {
  return process.env.DIAGNOSTIC_MODEL?.trim() || "claude-sonnet-5";
}

/** Primary verifier (OpenAI). Env: VERIFIER_MODEL */
export function getVerifierModel(): string {
  return process.env.VERIFIER_MODEL?.trim() || "gpt-5.6-terra";
}

/**
 * Strong verifier (OpenAI). Env: STRONG_VERIFIER_MODEL
 * If unset, strong tier is skipped.
 */
export function getStrongVerifierModel(): string | undefined {
  const raw = process.env.STRONG_VERIFIER_MODEL?.trim();
  return raw || undefined;
}

export function hasLlmConfigured(): boolean {
  return Boolean(getClaudeApiKey() && getOpenAiApiKey());
}
