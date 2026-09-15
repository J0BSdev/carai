import {
  getClaudeApiKey,
  getDiagnosticModel,
  getOpenAiApiKey,
  getStrongVerifierModel,
  getVerifierModel,
} from "./config";
import type { DiagnosticEngine } from "./engine";
import { DiagnosticPipelineError } from "./errors";
import {
  classifyGuardName,
  getActiveAiStep,
  logGuardRetry,
  runAiStep,
} from "./ai-telemetry";
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
  findDraftQualityIssue,
} from "./prompts";
import {
  extractReferenceSpecClaims,
  mergeTechnicalSpecClaims,
} from "./spec-guard";
import { findReasoningConsistencyIssue } from "./reasoning-consistency-guard";
import { isSafetyCriticalTestDraft } from "./safety-guard";
import {
  downgradeUnjustifiedConfirmed,
  findConfirmationGuardIssue,
  isContinueAfterFinish,
  isTechnicianRejection,
  mapHypothesisUiStatus,
  resolveDiagnosisCertainty,
} from "./confirmation-guard";
import type {
  AiActionType,
  DiagnosticCase,
  DiagnosticStep,
  DiagnoseResponse,
  DiagnosisCertainty,
  ExtractedCaseFacts,
  ExtractedMeasurement,
  Hypothesis,
  Observation,
  RejectedDiagnosis,
  VehicleInfo,
} from "./types";

/** Max Claude regenerations after the initial draft, per user step. */
const MAX_DIAGNOSTIC_RETRIES = 2;

/**
 * Mutable state of one diagnostic turn. The semantic delta belongs to the turn, not
 * to a single draft: a guard retry that omits semanticUpdate must not drop facts an
 * earlier draft of the same turn already extracted.
 */
type DiagnosticTurn = {
  retriesUsed: number;
  extracted: ExtractedCaseFacts | null;
};

const ALLOWED_ACTIONS: AiActionType[] = ["ASK", "TEST", "FINISH"];

function draftBlob(draft: LlmStepPayload): string {
  return [
    draft.content,
    draft.rationale,
    draft.expectedResultHint,
    draft.confirmedFault,
    ...(draft.facts ?? []),
    ...(draft.evidence ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

function hasTechnicalClaimsOrSpecs(draft: LlmStepPayload): boolean {
  const claims = Array.isArray(draft.technicalClaims) ? draft.technicalClaims : [];
  for (const c of claims) {
    const st = (c.sourceType ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    // GENERAL_PRINCIPLE fluff on ordinary ASK/TEST must not force verifier.
    if (c.vehicleSpecific === true) return true;
    if (st === "VERIFIED_OEM" || st === "VERIFIED_TECHNICAL") return true;
    if (
      (st === "MODEL_KNOWLEDGE" || st === "UNKNOWN") &&
      /\d/.test(`${c.valueText ?? ""} ${c.claim ?? ""}`)
    ) {
      return true;
    }
  }
  return extractReferenceSpecClaims(draftBlob(draft)).length > 0;
}

function hasHighConfidence(draft: LlmStepPayload): boolean {
  // Do NOT treat confidence:"high" alone — Claude often sets it on ordinary ASK/TEST.
  if (
    typeof draft.diagnosisConfidence === "number" &&
    draft.diagnosisConfidence >= 80
  ) {
    return true;
  }
  const certainty = (draft.diagnosisCertainty ?? "").toUpperCase();
  if (certainty === "CONFIRMED" || certainty === "HIGH_CONFIDENCE") return true;
  return false;
}

function looksExpensiveOrRiskyRecommendation(draft: LlmStepPayload): boolean {
  const n = draftBlob(draft)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return /(zamijeni|zamjeni|zamena|zamjena|replace\b|kupi nov|treba nov|ugradi nov|nova turbina|novi (ecu|pcm|modul|injektor|mjenjac|motor|katalizator)|skupa (popravka|zamjena|dijagnostik)|skupo |overhaul|komplet (turbine|mjenjaca|injektora))/.test(
    n,
  );
}

function hasContradictoryStrongEvidence(draft: LlmStepPayload): boolean {
  const hyps = draft.hypotheses ?? [];
  const active = hyps.filter((h) => {
    const st = (h.status ?? "").toUpperCase();
    return (
      st === "LIKELY" ||
      st === "LEADING" ||
      st === "POSSIBLE" ||
      st === "SUPPORTED" ||
      (typeof h.confidence === "number" && h.confidence >= 40)
    );
  });
  if (active.length < 2) {
    return active.some(
      (h) =>
        (h.supportingEvidence?.length ?? 0) > 0 &&
        (h.contradictingEvidence?.length ?? 0) > 0,
    );
  }
  const withSupport = active.filter(
    (h) => (h.supportingEvidence?.length ?? 0) > 0,
  );
  const withContra = active.filter(
    (h) => (h.contradictingEvidence?.length ?? 0) > 0,
  );
  return (
    withSupport.length >= 2 ||
    (withSupport.length >= 1 && withContra.length >= 1)
  );
}

/**
 * OpenAI verifier only for high-risk drafts.
 * Ordinary ASK/TEST that pass backend guards go straight to UI (including first step).
 */
export function shouldCallVerifier(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): boolean {
  if (draft.actionType === "FINISH") return true;
  if ((diagnosticCase.rejectedDiagnoses?.length ?? 0) > 0) return true;
  if (findReasoningConsistencyIssue(diagnosticCase, draft)) return true;
  if (hasTechnicalClaimsOrSpecs(draft)) return true;

  // Ordinary ASK (incl. first step): never call OpenAI after guards.
  if (draft.actionType === "ASK") return false;

  if (draft.actionType === "TEST") {
    if (isSafetyCriticalTestDraft(draft)) return true;
    if (looksExpensiveOrRiskyRecommendation(draft)) return true;
    if (hasHighConfidence(draft)) return true;
    return false;
  }

  return false;
}

/**
 * Strong verifier only when the case is truly stuck after primary+retry.
 * Never on normal ASK; never on ordinary TEST without stuck signals.
 * Max 1× per case (enforced via strongVerifierUsed).
 */
export function shouldEscalateToStrongVerifier(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  previousIssues: string[],
): boolean {
  if (diagnosticCase.strongVerifierUsed) return false;
  if (!getStrongVerifierModel()) return false;
  if (draft.actionType === "ASK") return false;
  if (previousIssues.length === 0) return false;

  const reasoningStillBroken = Boolean(
    findReasoningConsistencyIssue(diagnosticCase, draft),
  );
  const safetyOrExpensiveUnclear =
    isSafetyCriticalTestDraft(draft) ||
    looksExpensiveOrRiskyRecommendation(draft);
  const contradictory = hasContradictoryStrongEvidence(draft);

  if (draft.actionType === "FINISH") {
    // Primary already failed on a FINISH — escalate once if strong available.
    return true;
  }

  if (draft.actionType === "TEST") {
    return (
      reasoningStillBroken ||
      safetyOrExpensiveUnclear ||
      contradictory
    );
  }

  return false;
}

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
      note: h.note ?? undefined,
      confidence,
      supportingEvidence: h.supportingEvidence?.filter(Boolean),
      contradictingEvidence: h.contradictingEvidence?.filter(Boolean),
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
  let diagnosisCertainty: DiagnosisCertainty | undefined;
  let insufficientEvidence = payload.insufficientEvidence ?? undefined;
  let diagnosisConfidence = parseDiagnosisConfidence(payload.diagnosisConfidence);

  if (actionType === "FINISH") {
    diagnosisCertainty = resolveDiagnosisCertainty(payload);
    insufficientEvidence = diagnosisCertainty !== "CONFIRMED";
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
    confidence: payload.confidence ?? undefined,
    diagnosisCertainty,
    diagnosisConfidence,
    insufficientEvidence,
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
  };
}

function parseAiYear(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const y = Math.round(value);
    return y >= 1900 && y <= 2100 ? y : undefined;
  }
  if (typeof value === "string" && /^(19|20)\d{2}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function normalizeSymptomList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
}

function dedupeSymptoms(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Type validation only — the code is stored as stated, no namespace guessing. */
function normalizeAiDtcList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const code = v.trim().replace(/\s+/g, " ").toUpperCase();
    if (!code || code.length > 24) continue;
    out.push(code);
  }
  return out;
}

function parseAiNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.trim().replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Type validation only — `raw` stays verbatim, nothing is re-parsed from prose. */
function normalizeAiMeasurementList(values: unknown): ExtractedMeasurement[] {
  if (!Array.isArray(values)) return [];
  const out: ExtractedMeasurement[] = [];
  for (const v of values) {
    if (!v || typeof v !== "object") continue;
    const row = v as Record<string, unknown>;
    const raw = typeof row.raw === "string" ? row.raw.trim() : "";
    if (!raw || raw.length > 120) continue;

    const measurement: ExtractedMeasurement = { raw };
    const value = parseAiNumber(row.value);
    if (value !== undefined) measurement.value = value;
    if (typeof row.unit === "string" && row.unit.trim()) {
      measurement.unit = row.unit.trim();
    }
    if (typeof row.parameter === "string" && row.parameter.trim()) {
      measurement.parameter = row.parameter.trim();
    }
    out.push(measurement);
  }
  return out;
}

function measurementKey(m: ExtractedMeasurement | string): string {
  if (typeof m === "string") return m.trim().toLowerCase();
  return [m.parameter ?? "", m.raw].join("|").trim().toLowerCase();
}

function dedupeMeasurements(
  values: Array<ExtractedMeasurement | string>,
): Array<ExtractedMeasurement | string> {
  const out: Array<ExtractedMeasurement | string> = [];
  const seen = new Set<string>();
  for (const v of values) {
    const key = measurementKey(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Merge an explicit semanticUpdate into case facts. Pure — returns null when the
 * delta changes nothing. The model is the semantic extractor; this only validates
 * types, dedupes and merges.
 */
function mergeSemanticUpdate(
  prior: ExtractedCaseFacts,
  update: NonNullable<LlmStepPayload["semanticUpdate"]>,
): ExtractedCaseFacts | null {
  let vehicle = prior.vehicle;
  let symptoms = [...(prior.symptoms ?? [])];
  let dtcs = [...(prior.dtcs ?? [])];
  let measurements = [...(prior.measurements ?? [])];
  let changed = false;

  const rawVehicle = update.vehicle;
  if (rawVehicle && typeof rawVehicle === "object") {
    const patch: VehicleInfo = { ...vehicle };
    let vehicleChanged = false;

    const setField = <K extends keyof VehicleInfo>(
      key: K,
      value: VehicleInfo[K] | undefined,
    ) => {
      if (value === undefined || patch[key] === value) return;
      patch[key] = value;
      vehicleChanged = true;
    };

    if (typeof rawVehicle.make === "string" && rawVehicle.make.trim()) {
      setField("make", rawVehicle.make.trim());
    }
    if (typeof rawVehicle.model === "string" && rawVehicle.model.trim()) {
      setField("model", rawVehicle.model.trim());
    }
    setField("year", parseAiYear(rawVehicle.year));
    if (typeof rawVehicle.engine === "string" && rawVehicle.engine.trim()) {
      setField("engine", rawVehicle.engine.trim());
    }
    if (
      typeof rawVehicle.mileage === "number" &&
      Number.isFinite(rawVehicle.mileage)
    ) {
      setField("mileage", Math.round(rawVehicle.mileage));
    }

    if (vehicleChanged) {
      vehicle = patch;
      changed = true;
    }
  }

  const toAdd = normalizeSymptomList(update.symptomsAdd);
  if (toAdd.length) {
    const merged = dedupeSymptoms([...symptoms, ...toAdd]);
    if (merged.length !== symptoms.length) {
      symptoms = merged;
      changed = true;
    }
  }

  const toRemove = normalizeSymptomList(update.symptomsRemove);
  if (toRemove.length) {
    const removeKeys = new Set(toRemove.map((s) => s.toLowerCase()));
    const next = symptoms.filter((s) => !removeKeys.has(s.toLowerCase()));
    if (next.length !== symptoms.length) {
      symptoms = next;
      changed = true;
    }
  }

  const dtcsToAdd = normalizeAiDtcList(update.dtcsAdd);
  if (dtcsToAdd.length) {
    const merged = dedupeSymptoms([...dtcs, ...dtcsToAdd]);
    if (merged.length !== dtcs.length) {
      dtcs = merged;
      changed = true;
    }
  }

  const measurementsToAdd = normalizeAiMeasurementList(update.measurementsAdd);
  if (measurementsToAdd.length) {
    const merged = dedupeMeasurements([...measurements, ...measurementsToAdd]);
    if (merged.length !== measurements.length) {
      measurements = merged;
      changed = true;
    }
  }

  if (!changed) return null;

  return {
    ...prior,
    vehicle,
    symptoms: symptoms.length ? symptoms : undefined,
    dtcs: dtcs.length ? dtcs : undefined,
    measurements: measurements.length ? measurements : undefined,
  };
}

/**
 * Fold a diagnostic draft's semanticUpdate into the turn. Only drafts from the
 * diagnostic model reach this, so the verifier never acts as extractor.
 */
function recordSemanticUpdate(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): void {
  const update = draft.semanticUpdate;
  if (!update || typeof update !== "object") return;
  const merged = mergeSemanticUpdate(
    turn.extracted ?? diagnosticCase.extracted ?? {},
    update,
  );
  if (merged) turn.extracted = merged;
}

/**
 * Throwaway copy of the case carrying the turn's facts, so every part of the turn
 * judges the draft against the same state. Never persisted — a rejected draft
 * leaves no trace on the real case.
 */
function caseForTurn(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
): DiagnosticCase {
  if (!turn.extracted) return diagnosticCase;
  return { ...diagnosticCase, extracted: turn.extracted };
}

/** Persist case facts — only once the turn is accepted. */
function persistSemanticUpdate(
  diagnosticCase: DiagnosticCase,
  turn: DiagnosticTurn,
): void {
  if (turn.extracted) diagnosticCase.extracted = turn.extracted;
}

/** Guards evaluate the draft against the case including the turn's own facts. */
function findDraftQualityIssueInTurn(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): string | null {
  return findDraftQualityIssue(caseForTurn(turn, diagnosticCase), draft);
}

async function draftWithClaude(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  userPrompt: string,
  callMeta?: {
    role: "diagnostic" | "diagnostic_retry";
    reasonCalled: string;
    retryNumber: number;
  },
): Promise<LlmStepPayload> {
  const apiKey = getClaudeApiKey();
  if (!apiKey) {
    throw new Error("Nedostaje CLAUDE_API_KEY. Postavi ga u .env.");
  }

  const step = getActiveAiStep();
  const raw = await callAnthropicJson({
    apiKey,
    model: getDiagnosticModel(),
    system: DIAGNOSTIC_SYSTEM_PROMPT,
    user: userPrompt,
    telemetry: step
      ? {
          caseId: step.caseId,
          stepId: step.stepId,
          stepNumber: step.stepNumber,
          role: callMeta?.role ?? "diagnostic",
          reasonCalled: callMeta?.reasonCalled ?? "initial",
          retryNumber: callMeta?.retryNumber ?? 0,
        }
      : undefined,
  });

  const draft = parseJson<LlmStepPayload>(raw, "Claude dijagnostički odgovor");
  recordSemanticUpdate(turn, diagnosticCase, draft);
  return draft;
}

async function regenerateWithClaude(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  issues: string[],
  reasonCalled: string = "quality_gate",
): Promise<LlmStepPayload> {
  if (turn.retriesUsed >= MAX_DIAGNOSTIC_RETRIES) {
    throw new Error(
      `Dosegnut MAX_DIAGNOSTIC_RETRIES=${MAX_DIAGNOSTIC_RETRIES}; nema dodatnih Claude retryjeva.`,
    );
  }
  turn.retriesUsed += 1;

  const step = getActiveAiStep();
  const primaryIssue = issues[0] ?? reasonCalled;
  logGuardRetry({
    stepNumber: step?.stepNumber ?? diagnosticCase.steps.length + 1,
    guard: classifyGuardName(primaryIssue),
    retryNumber: turn.retriesUsed,
    issueSummary: primaryIssue,
  });

  const turnCase = caseForTurn(turn, diagnosticCase);
  return draftWithClaude(
    turn,
    turnCase,
    buildDiagnosticRetryPrompt(turnCase, draft, issues),
    {
      role: "diagnostic_retry",
      reasonCalled,
      retryNumber: turn.retriesUsed,
    },
  );
}

async function verifyWithOpenAi(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  options?: {
    model?: string;
    previousIssues?: string[];
    strongFinal?: boolean;
    retryNumber?: number;
    reasonCalled?: string;
  },
): Promise<VerifierPayload> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("Nedostaje OPENAI_API_KEY. Postavi ga u .env.");
  }

  const model = options?.model ?? getVerifierModel();
  const step = getActiveAiStep();
  const turnCase = caseForTurn(turn, diagnosticCase);
  const raw = await callOpenAiJson({
    apiKey,
    model,
    system: VERIFIER_SYSTEM_PROMPT,
    user: buildVerifierUserPrompt(turnCase, draft, {
      previousIssues: options?.previousIssues,
      strongFinal: options?.strongFinal,
    }),
    telemetry: step
      ? {
          caseId: step.caseId,
          stepId: step.stepId,
          stepNumber: step.stepNumber,
          role: options?.strongFinal ? "strong_verifier" : "verifier",
          reasonCalled:
            options?.reasonCalled ??
            (options?.strongFinal ? "strong_escalate" : "verifier_required"),
          retryNumber: options?.retryNumber ?? 0,
        }
      : undefined,
  });

  const parsed = parseJson<VerifierPayload>(raw, "OpenAI verifier odgovor");
  const verdict: VerifierPayload = {
    approved: Boolean(parsed.approved),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    correctedStep: parsed.correctedStep ?? null,
  };

  const contradiction =
    findReasoningConsistencyIssue(turnCase, draft) ??
    (verdict.correctedStep
      ? findReasoningConsistencyIssue(turnCase, verdict.correctedStep)
      : null);
  if (contradiction) {
    return {
      approved: false,
      issues: [contradiction, ...verdict.issues].slice(0, 3),
      correctedStep: null,
    };
  }

  return verdict;
}

async function applyConfirmationPolicy(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): Promise<LlmStepPayload> {
  if (draft.actionType !== "FINISH") return draft;
  const issue = findConfirmationGuardIssue(diagnosticCase, draft);
  if (!issue) {
    const certainty = resolveDiagnosisCertainty(draft);
    return {
      ...draft,
      diagnosisCertainty: certainty,
      insufficientEvidence: certainty !== "CONFIRMED",
    };
  }
  return {
    ...downgradeUnjustifiedConfirmed(draft, issue),
    actionType: "FINISH",
  } as LlmStepPayload;
}

/**
 * Safe backend fallback after strong reject / terminal verifier failure.
 * Never CONFIRMED. No further AI escalation.
 */
function buildSafeVerifierFallback(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  issues: string[],
): LlmStepPayload {
  const issueSummary =
    issues.filter(Boolean).slice(0, 2).join("; ") ||
    "nedovoljno pouzdanih dokaza";

  if (draft.actionType === "FINISH") {
    let next: LlmStepPayload = {
      ...draft,
      actionType: "FINISH",
      diagnosisCertainty: "LIKELY",
      insufficientEvidence: true,
      confidence: "medium",
    };
    const confIssue = findConfirmationGuardIssue(diagnosticCase, next);
    if (confIssue) {
      next = {
        ...downgradeUnjustifiedConfirmed(next, confIssue),
        actionType: "FINISH",
      } as LlmStepPayload;
    }
    if ((next.diagnosisCertainty ?? "").toUpperCase() === "CONFIRMED") {
      next = {
        ...next,
        diagnosisCertainty: "LIKELY",
        insufficientEvidence: true,
      };
    }
    const certainty = resolveDiagnosisCertainty(next);
    const supportedLikely =
      certainty === "LIKELY" || certainty === "HIGH_CONFIDENCE";
    return {
      ...next,
      diagnosisCertainty: supportedLikely ? certainty : "SUSPECTED",
      insufficientEvidence: true,
      confirmedFault:
        next.confirmedFault?.trim() ||
        "Vodeća sumnja (nije CONFIRMED — potreban dodatni dokaz)",
      content:
        `${supportedLikely ? "LIKELY" : "SUSPECTED"} / NEEDS CONFIRMATION: ` +
        `${(next.content || next.confirmedFault || "vodeća sumnja").trim()}. ` +
        `Verifier nije odobrio potvrdu. Potreban dodatni dokaz (${issueSummary}).`,
      rationale: `Siguran fallback nakon verifier eskalacije — nema CONFIRMED bez dovoljnog dokaza. ${issueSummary}`,
    };
  }

  return {
    actionType: "ASK",
    content:
      "Prije sigurnog nastavka potreban je dodatni konkretan dokaz. Koje mjerenje ili opažanje možeš sada dodati?",
    rationale: `Siguran fallback: verifier nije odobrio korak (${issueSummary}). Nema daljnje AI eskalacije.`,
    expectedResultHint: "Konkretan rezultat mjerenja ili opažanja",
    confirmedFault: null,
    confidence: "low",
    insufficientEvidence: true,
    askDecision: {
      whyNeeded:
        "Bez dodatnog dokaza nije sigurno nastaviti nakon verifier odbijanja",
      expectedAnswers: [
        "Imam novo mjerenje/opažanje",
        "Nemam dodatni dokaz sada",
      ],
      nextStepByAnswer: [
        {
          answer: "Imam novo mjerenje/opažanje",
          nextAction: "TEST ili reevaluate prema novom dokazu",
        },
        {
          answer: "Nemam dodatni dokaz sada",
          nextAction: "FINISH LIKELY/SUSPECTED s insufficientEvidence",
        },
      ],
    },
    facts: draft.facts ?? null,
    evidence: draft.evidence ?? null,
    hypotheses: draft.hypotheses ?? null,
  };
}

function buildGuardRetryIssues(
  draft: LlmStepPayload,
  issue: string | null,
  extraIssues: string[],
): string[] {
  const askRejected =
    draft.actionType === "ASK" ||
    extraIssues.some((i) => /ASK REJECT/i.test(i)) ||
    (issue != null && /ASK REJECT/i.test(issue));

  const safetyRejected =
    extraIssues.some((i) => /SAFETY REJECT/i.test(i)) ||
    (issue != null && /SAFETY REJECT/i.test(issue));

  const goalRejected =
    (issue != null &&
      /Semantički sličan već završenom|Ponavljanje iste dijagnostičke grane|Ponavljanje već završenog testa|Odaberi NEOVIS/i.test(
        issue,
      )) ||
    extraIssues.some((i) =>
      /Semantički sličan već završenom|Ponavljanje iste dijagnostičke grane|Odaberi NEOVIS/i.test(
        i,
      ),
    );

  const skippedMethodRepeat =
    (issue != null &&
      /skipped\/unavailable.*ist(a|om) (test)?method|ista method|isti testMethod/i.test(
        issue,
      )) ||
    extraIssues.some((i) =>
      /skipped\/unavailable.*method|isti testMethod/i.test(i),
    );

  const goal = draft.diagnosticGoal?.trim();
  const target = draft.diagnosticTarget?.trim();

  return [
    ...(issue ? [issue] : []),
    ...extraIssues,
    askRejected
      ? "ASK je odbijen backend gateom. actionType MORA biti TEST — odmah odaberi najbolji sljedeći dijagnostički test. Ne vraćaj ASK."
      : "",
    goalRejected
      ? "Guard odbija trenutni diagnosticGoal — odaberi DRUGAČIJI diagnosticGoal (neovisna grana). Ne ponavljaj isti goal."
      : "",
    skippedMethodRepeat
      ? "Skipped test s istim testMethod — predloži DRUGAČIJI testMethod za isti diagnosticGoal, ili novi goal."
      : "",
    safetyRejected
      ? "SAFETY REJECT: regeneriraj isti TEST (isti diagnosticTarget + diagnosticGoal) s obaveznim safetyPreconditions + upozorenjima u content (SRS: deaktivacija/odspajanje napajanja prije rada; ne izmišljaj wait time — needsVerifiedProcedure)."
      : "",
    !goalRejected &&
      !askRejected &&
      draft.actionType === "TEST" &&
      target &&
      goal
      ? `Quality/format fix: zadrži diagnosticTarget="${target}" i diagnosticGoal="${goal}"; popravi samo navedeni issue (content/safety/meta/format). Ne mijenjaj granu.`
      : "",
    !goalRejected &&
      !askRejected &&
      draft.actionType === "TEST" &&
      (!target || !goal)
      ? "Popravi issue; ako su diagnosticTarget/diagnosticGoal poznati, zadrži ih. Novu granu biraj samo ako je goal eksplicitno odbijen."
      : "",
    draft.actionType === "TEST" || askRejected
      ? "Za TEST uvijek vrati diagnosticTarget, diagnosticGoal, testMethod."
      : "",
  ].filter(Boolean);
}

/**
 * 3-tier pipeline:
 * 1) Claude proposes ASK/TEST/FINISH.
 * 2) Programmatic guards (bounded Claude retries).
 * 3) Primary verifier only when selective conditions match.
 * 4) Strong verifier at most once per case when still stuck; else safe fallback.
 */
async function callVerifiedDiagnosticStep(
  diagnosticCase: DiagnosticCase,
): Promise<DiagnosticStep> {
  const stepNumber = diagnosticCase.steps.length + 1;
  const stepId = `step-${stepNumber}`;
  const turn: DiagnosticTurn = { retriesUsed: 0, extracted: null };

  return runAiStep(
    {
      caseId: diagnosticCase.id,
      stepId,
      stepNumber,
    },
    async () => {
      let draft = await draftWithClaude(
        turn,
        diagnosticCase,
        buildDiagnosticUserPrompt(diagnosticCase),
        { role: "diagnostic", reasonCalled: "initial", retryNumber: 0 },
      );

      draft = await ensureDraftPassesQualityGates(turn, diagnosticCase, draft);
      draft = await applyConfirmationPolicy(
        caseForTurn(turn, diagnosticCase),
        draft,
      );

      if (shouldCallVerifier(caseForTurn(turn, diagnosticCase), draft)) {
        draft = await runSelectiveVerifier(turn, diagnosticCase, draft);
      }

      draft = await applyConfirmationPolicy(
        caseForTurn(turn, diagnosticCase),
        draft,
      );

      // Turn accepted — only now do the model's case facts reach the real case.
      persistSemanticUpdate(diagnosticCase, turn);
      return toDiagnosticStep(draft, stepId);
    },
  );
}

async function applyVerifierCorrection(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  corrected: LlmStepPayload,
): Promise<LlmStepPayload> {
  const correctedIssue = findDraftQualityIssueInTurn(
    turn,
    diagnosticCase,
    corrected,
  );
  if (!correctedIssue) return corrected;
  return ensureDraftPassesQualityGates(turn, diagnosticCase, corrected, [
    correctedIssue,
  ]);
}

async function runSelectiveVerifier(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
): Promise<LlmStepPayload> {
  let draft = initialDraft;
  const collectedIssues: string[] = [];

  let verdict = await verifyWithOpenAi(turn, diagnosticCase, draft, {
    retryNumber: 0,
    reasonCalled: "verifier_required",
  });
  if (verdict.approved) return draft;

  if (verdict.correctedStep) {
    return applyVerifierCorrection(turn, diagnosticCase, verdict.correctedStep);
  }

  collectedIssues.push(
    ...(verdict.issues.length
      ? verdict.issues
      : ["Primary verifier odbio draft"]),
  );

  if (turn.retriesUsed < MAX_DIAGNOSTIC_RETRIES) {
    draft = await regenerateWithClaude(
      turn,
      diagnosticCase,
      draft,
      collectedIssues,
      "verifier_rejected",
    );
    draft = await ensureDraftPassesQualityGates(turn, diagnosticCase, draft);

    if (!shouldCallVerifier(caseForTurn(turn, diagnosticCase), draft)) {
      return draft;
    }

    verdict = await verifyWithOpenAi(turn, diagnosticCase, draft, {
      retryNumber: 1,
      reasonCalled: "verifier_required",
    });
    if (verdict.approved) return draft;
    if (verdict.correctedStep) {
      return applyVerifierCorrection(
        turn,
        diagnosticCase,
        verdict.correctedStep,
      );
    }
    collectedIssues.push(
      ...(verdict.issues.length
        ? verdict.issues
        : ["Primary verifier odbio i nakon retryja"]),
    );
  }

  const turnCase = caseForTurn(turn, diagnosticCase);
  if (shouldEscalateToStrongVerifier(turnCase, draft, collectedIssues)) {
    return runStrongVerifierOnce(turn, diagnosticCase, draft, collectedIssues);
  }

  return buildSafeVerifierFallback(turnCase, draft, collectedIssues);
}

async function runStrongVerifierOnce(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  previousIssues: string[],
): Promise<LlmStepPayload> {
  const turnCase = caseForTurn(turn, diagnosticCase);
  const strongModel = getStrongVerifierModel();
  if (!strongModel) {
    return buildSafeVerifierFallback(turnCase, draft, previousIssues);
  }

  diagnosticCase.strongVerifierUsed = true;

  const verdict = await verifyWithOpenAi(turn, diagnosticCase, draft, {
    model: strongModel,
    previousIssues,
    strongFinal: true,
    retryNumber: 0,
    reasonCalled: "strong_escalate",
  });

  if (verdict.approved) {
    return draft;
  }

  if (verdict.correctedStep) {
    const corrected = verdict.correctedStep;
    const correctedIssue = findDraftQualityIssueInTurn(
      turn,
      diagnosticCase,
      corrected,
    );
    if (!correctedIssue) {
      return applyConfirmationPolicy(turnCase, corrected);
    }
    return buildSafeVerifierFallback(turnCase, draft, [
      ...previousIssues,
      ...verdict.issues,
      correctedIssue,
    ]);
  }

  return buildSafeVerifierFallback(turnCase, draft, [
    ...previousIssues,
    ...verdict.issues,
  ]);
}

async function ensureDraftPassesQualityGates(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
  extraIssues: string[] = [],
): Promise<LlmStepPayload> {
  let draft = initialDraft;

  if (draft.actionType === "FINISH") {
    const confIssue = findConfirmationGuardIssue(
      caseForTurn(turn, diagnosticCase),
      draft,
    );
    if (confIssue) {
      draft = {
        ...downgradeUnjustifiedConfirmed(draft, confIssue),
        actionType: "FINISH",
      } as LlmStepPayload;
    }
  }

  let issue = findDraftQualityIssueInTurn(turn, diagnosticCase, draft);
  let pendingExtra = [...extraIssues];
  if (!issue && pendingExtra.length === 0) return draft;

  if (turn.retriesUsed >= MAX_DIAGNOSTIC_RETRIES) {
    return finalizeAfterRetryLimit(turn, diagnosticCase, draft, issue);
  }

  draft = await regenerateWithClaude(
    turn,
    diagnosticCase,
    draft,
    buildGuardRetryIssues(draft, issue, pendingExtra),
  );
  pendingExtra = [];
  issue = findDraftQualityIssueInTurn(turn, diagnosticCase, draft);

  if (
    draft.actionType === "ASK" &&
    issue &&
    turn.retriesUsed < MAX_DIAGNOSTIC_RETRIES
  ) {
    draft = await regenerateWithClaude(
      turn,
      diagnosticCase,
      draft,
      [
        issue,
        "OBAVEZNO: actionType=TEST. Nemoj vraćati ASK. Odaberi najbolji diskriminirajući test iz CASE STATE.",
      ],
    );
    issue = findDraftQualityIssueInTurn(turn, diagnosticCase, draft);
  }

  if (
    issue &&
    /SAFETY REJECT/i.test(issue) &&
    draft.actionType === "TEST" &&
    turn.retriesUsed < MAX_DIAGNOSTIC_RETRIES
  ) {
    draft = await regenerateWithClaude(
      turn,
      diagnosticCase,
      draft,
      [
        issue,
        "OBAVEZNO: actionType=TEST s safetyPreconditions.",
        "U content na početku navedi sigurnosne korake.",
        "SRS/airbag konektor/modul: deaktiviraj sustav / odspoji napajanje PRIJE rada.",
        "Ne izmišljaj vehicle-specific vrijeme čekanja — needsVerifiedProcedure=true.",
        "technicalClaims[]: svaka tvrdnja mora imati ispravan sourceType.",
      ],
    );
    issue = findDraftQualityIssueInTurn(turn, diagnosticCase, draft);
  }

  if (!issue) return draft;

  if (turn.retriesUsed < MAX_DIAGNOSTIC_RETRIES) {
    draft = await regenerateWithClaude(
      turn,
      diagnosticCase,
      draft,
      buildGuardRetryIssues(draft, issue, [
        "Ako completedTests snažno podupiru LEADING hipotezu → FINISH, ali BEZ izmišljenih OEM brojki; bez verifiedTechnicalSpecs ne smiješ CONFIRMED usporedbom measured vs expected.",
        "Inače: jedan TEST koji razlikuje LEADING od najjače alternative.",
        "U rationale navedi koje hipoteze razlikuješ.",
        "Ne navodi NITI JEDAN vehicle-specific brojčani OEM/referentni raspon (Ω/V/bar/…) bez verifiedTechnicalSpecs.",
        "Ako actionType=FINISH: insufficientEvidence=true; LIKELY / NEEDS CONFIRMATION bez UNVERIFIED spece.",
      ]),
    );
    issue = findDraftQualityIssueInTurn(turn, diagnosticCase, draft);
    if (!issue) return draft;
  }

  return finalizeAfterRetryLimit(turn, diagnosticCase, draft, issue);
}

/**
 * Retry budget spent. A failing ASK/TEST is never turned into a FINISH — exhausted
 * retries must not invent a conclusion. An existing FINISH may only be softened
 * through the confirmation policy that already owns certainty.
 */
async function finalizeAfterRetryLimit(
  turn: DiagnosticTurn,
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  issue: string | null,
): Promise<LlmStepPayload> {
  if (!issue) return draft;

  if (draft.actionType === "FINISH") {
    const softened = await applyConfirmationPolicy(
      caseForTurn(turn, diagnosticCase),
      draft,
    );
    if (!findDraftQualityIssueInTurn(turn, diagnosticCase, softened)) {
      return softened;
    }
  }

  throw new DiagnosticPipelineError(
    `Draft nije prošao quality guard nakon retry limita: ${issue}`,
  );
}

function formatStepMessage(
  actionType: string,
  diagnosticCase: DiagnosticCase,
  suffix = "",
): string {
  const strong = diagnosticCase.strongVerifierUsed
    ? ` + strong ${getStrongVerifierModel()}`
    : "";
  return `AI (${getDiagnosticModel()} + verifier ${getVerifierModel()}${strong}): ${actionType}${suffix}`;
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
      // Filled by the first draft's semanticUpdate — no backend text parsing.
      extracted: {},
      observations: [],
      steps: [],
      status: "active",
    };

    const nextStep = await callVerifiedDiagnosticStep(baseCase);
    const isFinish = nextStep.actionType === "FINISH";
    const draftText = [
      nextStep.content,
      nextStep.rationale,
      nextStep.confirmedFault,
    ]
      .filter(Boolean)
      .join("\n");

    const diagnosticCase: DiagnosticCase = {
      ...baseCase,
      extracted: baseCase.extracted,
      steps: [nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish ? nextStep.confirmedFault : undefined,
      technicalSpecClaims: mergeTechnicalSpecClaims(baseCase, draftText),
      strongVerifierUsed: baseCase.strongVerifierUsed,
    };

    return {
      case: diagnosticCase,
      nextStep,
      message: formatStepMessage(nextStep.actionType, diagnosticCase),
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

    const currentStep = diagnosticCase.steps[diagnosticCase.steps.length - 1];
    if (!currentStep) {
      throw new Error("Slučaj nema aktivni korak za zabilježiti");
    }

    const reopenAfterFinish =
      currentStep.actionType === "FINISH" &&
      (isTechnicianRejection(trimmed) || isContinueAfterFinish(trimmed));

    if (diagnosticCase.status === "completed" && !reopenAfterFinish) {
      return {
        case: diagnosticCase,
        nextStep: null,
        message: "Slučaj je već završen.",
      };
    }

    if (currentStep.actionType === "FINISH") {
      if (!reopenAfterFinish) {
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

      const rejectedDiagnoses: RejectedDiagnosis[] = [
        ...(diagnosticCase.rejectedDiagnoses ?? []),
      ];
      if (isTechnicianRejection(trimmed)) {
        rejectedDiagnoses.push({
          diagnosis:
            currentStep.confirmedFault?.trim() || currentStep.content.trim(),
          rejectedAtStep: currentStep.id,
          reason: "technician_rejected",
          rejectedAt: new Date().toISOString(),
        });
      }

      const softenedSteps = diagnosticCase.steps.map((s) =>
        s.id === currentStep.id
          ? {
              ...s,
              diagnosisCertainty: "LIKELY" as DiagnosisCertainty,
              insufficientEvidence: true,
            }
          : s,
      );

      const rejectionObservation: Observation = {
        stepId: currentStep.id,
        resultText: trimmed,
        recordedAt: new Date().toISOString(),
      };

      const reopened: DiagnosticCase = {
        ...diagnosticCase,
        steps: softenedSteps,
        status: "active",
        confirmedFault: undefined,
        rejectedDiagnoses,
        observations: [...diagnosticCase.observations, rejectionObservation],
      };

      const nextStep = await callVerifiedDiagnosticStep(reopened);
      const isFinish = nextStep.actionType === "FINISH";
      const draftText = [
        nextStep.content,
        nextStep.rationale,
        nextStep.confirmedFault,
      ]
        .filter(Boolean)
        .join("\n");

      const updated: DiagnosticCase = {
        ...reopened,
        steps: [...reopened.steps, nextStep],
        status: isFinish ? "completed" : "active",
        confirmedFault: isFinish ? nextStep.confirmedFault : undefined,
        technicalSpecClaims: mergeTechnicalSpecClaims(reopened, draftText),
        strongVerifierUsed: reopened.strongVerifierUsed,
      };

      return {
        case: updated,
        nextStep,
        message: formatStepMessage(
          nextStep.actionType,
          updated,
          ` (reevaluate after ${isTechnicianRejection(trimmed) ? "rejection" : "continue"})`,
        ),
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
    const draftText = [
      nextStep.content,
      nextStep.rationale,
      nextStep.confirmedFault,
    ]
      .filter(Boolean)
      .join("\n");

    const updated: DiagnosticCase = {
      ...caseWithObservation,
      steps: [...caseWithObservation.steps, nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish
        ? nextStep.confirmedFault
        : caseWithObservation.confirmedFault,
      technicalSpecClaims: mergeTechnicalSpecClaims(
        caseWithObservation,
        draftText,
      ),
      strongVerifierUsed: caseWithObservation.strongVerifierUsed,
    };

    return {
      case: updated,
      nextStep,
      message: formatStepMessage(nextStep.actionType, updated),
    };
  }
}
