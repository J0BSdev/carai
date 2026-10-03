import type { DiagnosticCase, Observation, TechnicianOutcome } from "./types";
import { observationResultText } from "./observation";
import { buildKnownFactsSnapshot, latestHypotheses } from "./known-facts";
import {
  collectHistoricalReferenceClaims,
  findSpecGuardIssue,
  getVerifiedTechnicalSpecs,
} from "./spec-guard";
import { findConfirmationGuardIssue, findTechnicianOutcomeConsistencyIssue } from "./confirmation-guard";
import { findSafetyAndTechnicalRuleIssue } from "./safety-guard";
import { issue, type GuardIssue } from "./guard-issue";
import { logDiagnosticUserPromptChars } from "./ai-telemetry";
import type { LlmStepPayload } from "./providers";

export const DIAGNOSTIC_SYSTEM_PROMPT = `AI dijagnostički copilot. Ti interpretiraš mechanic tekst i biraš točno jednu akciju: ASK | TEST | FINISH. Backend ne parsira tekst i ne mijenja actionType. Hrvatski. Jedan korak, bez liste.

TEST čim ima dovoljno podataka. ASK samo ako odgovor mijenja sljedeći korak.
DTC-first: knownFacts.knownDtcCodes koristi odmah. Ne rescan, ne opća lampica/simptom pitanja, ne pitaj ponovno vozilo.
Ako je sigurno i izvedivo, direktno mjerenje na granici komponente (ulaz/napajanje/masa/signal) prije upstream/indirektnog (relej, osigurač, ECU, zvuk, vizual).
technicianOutcome samo iz trenutnog RESULT.text. SKIP, CANNOT_PERFORM, REJECT_DIAGNOSIS, CONTINUE_AFTER_FINISH i originalComplaint nisu mechanic result — izostavi ga. FAULT_CONFIRMED ili REPAIR_CONFIRMED → FINISH; FAULT_CONFIRMED treba fault ili confirmedFault. Ne čini spec VERIFIED.
Ne izmišljaj OEM brojke, pinove ni raspone. Nije u verifiedTechnicalSpecs → nije dokaz. technicalClaims.sourceType: VERIFIED_OEM | VERIFIED_TECHNICAL | GENERAL_PRINCIPLE | MODEL_KNOWLEDGE | UNKNOWN. VERIFIED_* samo iz verifiedTechnicalSpecs.
Safety warning samo uz stvaran rizik (živi SRS, HV, pirotehnika, otvoreni hidraulički tlak): jedna rečenica što napraviti prije rada. Rutinski test bez warninga.
FINISH nosi diagnosisCertainty SUSPECTED|LIKELY|HIGH_CONFIDENCE|CONFIRMED i diagnosisConfidence iz ovog drafta. CONFIRMED samo uz neovisan jak dokaz ili ovaj-turn FAULT_CONFIRMED|REPAIR_CONFIRMED. Inače insufficientEvidence=true. Poštuj rejectedDiagnoses.

semanticUpdate samo kad RESULT dodaje vehicle, symptoms, DTC ili measurements, ili kad postoji technicianOutcome. dtcsAdd doslovno. measurementsAdd.raw verbatim.

JSON bez markdowna. Prazna polja izostavi.
TEST: actionType, content, rationale, expectedResultHint, diagnosticTarget, diagnosticGoal, testMethod. testGuide samo za nerutinski test.
ASK: actionType, content, rationale, askDecision.
FINISH: actionType, content, rationale, confirmedFault, diagnosisCertainty, diagnosisConfidence, insufficientEvidence.
{"actionType":"TEST","content":"…","rationale":"…","expectedResultHint":"…","diagnosticTarget":"…","diagnosticGoal":"…","testMethod":"…"}`;

/** Case facts serialized into prompts. Result text is raw; the model interprets it. */
export function buildCaseState(diagnosticCase: DiagnosticCase) {
  const stepHistory: Array<{
    actionType: string;
    content: string;
    result: string | null;
    kind?: Observation["kind"];
    reason?: string;
    diagnosticTarget?: string;
    diagnosticGoal?: string;
    testMethod?: string;
  }> = [];

  const knownFacts = buildKnownFactsSnapshot(diagnosticCase);

  for (const step of diagnosticCase.steps) {
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    const result = observationResultText(obs);
    const stepLabel =
      step.actionType === "TEST"
        ? step.recommendedTest?.name?.trim() || step.content
        : step.content;

    stepHistory.push({
      actionType: step.actionType,
      content: stepLabel,
      result,
      ...(obs ? { kind: obs.kind } : {}),
      ...(obs?.kind === "CANNOT_PERFORM" && obs.reason
        ? { reason: obs.reason }
        : {}),
      ...(step.diagnosticTarget
        ? { diagnosticTarget: step.diagnosticTarget }
        : {}),
      ...(step.diagnosticGoal ? { diagnosticGoal: step.diagnosticGoal } : {}),
      ...(step.testMethod ? { testMethod: step.testMethod } : {}),
    });
  }

  return {
    originalComplaint: diagnosticCase.problemText,
    knownFacts,
    currentHypotheses: latestHypotheses(diagnosticCase).map((h) => ({
      hypothesis: h.label,
      status: h.status,
      confidence: h.confidence ?? null,
      supportingEvidence: h.supportingEvidence ?? [],
      contradictingEvidence: h.contradictingEvidence ?? [],
      note: h.note ?? null,
    })),
    diagnosticStepHistory: stepHistory,
    status: diagnosticCase.status,
    verifiedTechnicalSpecs: getVerifiedTechnicalSpecs(diagnosticCase),
    claimedReferenceSpecs: collectHistoricalReferenceClaims(diagnosticCase).map(
      (c) => ({
        parameterKey: c.parameterKey,
        valueText: c.valueText,
        unit: c.unit,
        condition: c.condition,
        status: c.status,
        source: c.source ?? null,
        vehicleEngineMatch: c.vehicleEngineMatch ?? null,
      }),
    ),
    rejectedDiagnoses: diagnosticCase.rejectedDiagnoses ?? [],
  };
}

type CaseStepHistoryRow = ReturnType<
  typeof buildCaseState
>["diagnosticStepHistory"][number];

function historyRow(s: CaseStepHistoryRow): Record<string, unknown> {
  const row: Record<string, unknown> = {
    actionType: s.actionType,
    content: s.content,
  };
  if (s.result != null) row.result = s.result;
  if (s.kind) row.kind = s.kind;
  if (s.reason) row.reason = s.reason;
  if (s.diagnosticTarget) row.diagnosticTarget = s.diagnosticTarget;
  if (s.diagnosticGoal) row.diagnosticGoal = s.diagnosticGoal;
  if (s.testMethod) row.testMethod = s.testMethod;
  return row;
}

/** Prompt CASE STATE. Omits empty fields. History is the raw step list. */
export function compactCaseStateForPrompt(
  state: ReturnType<typeof buildCaseState>,
) {
  const kf = state.knownFacts;
  const knownFactsCompact: Record<string, unknown> = {};
  if (kf.vehicle) knownFactsCompact.vehicle = kf.vehicle;
  if (kf.knownDtcCodes.length) knownFactsCompact.knownDtcCodes = kf.knownDtcCodes;
  if (kf.symptoms.length) knownFactsCompact.symptoms = kf.symptoms;
  if (kf.measurements.length) knownFactsCompact.measurements = kf.measurements;

  const out: Record<string, unknown> = {
    originalComplaint: state.originalComplaint,
    knownFacts: knownFactsCompact,
    history: state.diagnosticStepHistory.map(historyRow),
    status: state.status,
  };

  if (state.currentHypotheses.length) {
    out.currentHypotheses = state.currentHypotheses.map((h) => {
      const row: Record<string, unknown> = {
        hypothesis: h.hypothesis,
        status: h.status,
        confidence: h.confidence,
      };
      if (h.supportingEvidence?.length) {
        row.supportingEvidence = h.supportingEvidence;
      }
      if (h.contradictingEvidence?.length) {
        row.contradictingEvidence = h.contradictingEvidence;
      }
      if (h.note) row.note = h.note;
      return row;
    });
  }

  if (state.verifiedTechnicalSpecs.length) {
    out.verifiedTechnicalSpecs = state.verifiedTechnicalSpecs;
  }

  if (state.claimedReferenceSpecs.length) {
    out.claimedReferenceSpecs = state.claimedReferenceSpecs.map((c) => {
      const row: Record<string, unknown> = {
        parameterKey: c.parameterKey,
        valueText: c.valueText,
        status: c.status,
      };
      if (c.unit) row.unit = c.unit;
      if (c.condition) row.condition = c.condition;
      if (c.source) row.source = c.source;
      if (c.vehicleEngineMatch) row.vehicleEngineMatch = c.vehicleEngineMatch;
      return row;
    });
  }

  if (state.rejectedDiagnoses.length) {
    out.rejectedDiagnoses = state.rejectedDiagnoses;
  }

  return out;
}

export function buildDiagnosticUserPrompt(diagnosticCase: DiagnosticCase): string {
  const prompt = [
    "CASE STATE:",
    JSON.stringify(compactCaseStateForPrompt(buildCaseState(diagnosticCase))),
  ].join("\n");

  logDiagnosticUserPromptChars(prompt.length);
  return prompt;
}

const RETRY_DRAFT_KEYS = [
  "actionType",
  "content",
  "rationale",
  "diagnosticTarget",
  "diagnosticGoal",
  "testMethod",
  "expectedResultHint",
  "confirmedFault",
  "diagnosisCertainty",
  "diagnosisConfidence",
  "insufficientEvidence",
  "testGuide",
] as const;

function compactRetryDraft(previousDraft: unknown): Record<string, unknown> {
  if (!previousDraft || typeof previousDraft !== "object" || Array.isArray(previousDraft)) {
    return {};
  }
  const source = previousDraft as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RETRY_DRAFT_KEYS) {
    const value = source[key];
    if (value == null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function isGuardIssue(value: GuardIssue | string): value is GuardIssue {
  return typeof value === "object" && value !== null && "code" in value;
}

export function buildDiagnosticRetryPrompt(
  diagnosticCase: DiagnosticCase,
  previousDraft: unknown,
  issues: Array<GuardIssue | string>,
): string {
  const issueLines = issues.map((item) =>
    isGuardIssue(item) ? item.message : item,
  );

  return [
    "CASE STATE:",
    JSON.stringify(compactCaseStateForPrompt(buildCaseState(diagnosticCase))),
    "",
    "Vrati ispravljeni JSON koji rješava ISSUES.",
    "ISSUES:",
    ...issueLines.map((line) => `- ${line}`),
    "",
    "PREVIOUS DRAFT:",
    JSON.stringify(compactRetryDraft(previousDraft)),
  ].join("\n");
}

export const VERIFIER_SYSTEM_PROMPT = `Quality gate. Ne vodi dijagnostiku i ne prepravlja draft. Samo approved i do 2 issues.

Odbij ako draft nije točno jedna ASK|TEST|FINISH, ponavlja poznato, tretira skipped kao dokaz, ne prati CASE STATE, izmišlja OEM brojku ili pin izvan verifiedTechnicalSpecs, ili opasan TEST (živi SRS, HV, pirotehnika) nema jednu praktičnu rečenicu prije rada.
CONFIRMED samo uz neovisan jak dokaz ili currentTurn.technicianOutcome FAULT_CONFIRMED|REPAIR_CONFIRMED na FINISH. technicianOutcome nije trusted fact: raw RESULT i aktivni korak moraju ga podupirati. rejectedDiagnoses su u CASE STATE.

{"approved":boolean,"issues":["..."]}`;

export function buildVerifierUserPrompt(
  diagnosticCase: DiagnosticCase,
  draft: unknown,
  options?: {
    /** Prior primary-verifier / guard issues for strong-tier escalation. */
    previousIssues?: string[];
    /** Strong final verdict mode — no new diagnostic branch. */
    strongFinal?: boolean;
    /** Current-turn AI extraction only — not persisted case facts. */
    technicianOutcome?: TechnicianOutcome | null;
  },
): string {
  const compact = compactCaseStateForPrompt(buildCaseState(diagnosticCase));
  const notes: string[] = [];

  if (options?.strongFinal) {
    notes.push("STRONG FINAL: odobri ili odbij. Ne biraj novu granu.");
  }
  if (options?.previousIssues?.length) {
    notes.push(
      "Prethodni issues:",
      ...options.previousIssues.slice(0, 6).map((i) => `- ${i}`),
    );
  }

  const lastStep = diagnosticCase.steps[diagnosticCase.steps.length - 1];
  const lastObs = lastStep
    ? diagnosticCase.observations.find((o) => o.stepId === lastStep.id)
    : undefined;
  const currentTurn = {
    technicianOutcome: options?.technicianOutcome ?? null,
    activeStep: lastStep
      ? { actionType: lastStep.actionType, content: lastStep.content }
      : null,
    lastMechanicResult: observationResultText(lastObs),
    observationKind: lastObs?.kind ?? null,
  };

  return [
    "CASE STATE:",
    JSON.stringify(compact),
    "",
    "CURRENT TURN:",
    JSON.stringify(currentTurn),
    "",
    "DRAFT:",
    JSON.stringify(draft),
    notes.length ? notes.join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Structural gates only. Semantic repeat, DTC, priority and hypothesis checks belong to the model and verifier. */
export function findDraftQualityIssue(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
  technicianOutcome?: TechnicianOutcome | null,
): GuardIssue | null {
  return (
    findTechnicianOutcomeConsistencyIssue(technicianOutcome, draft) ??
    findSafetyAndTechnicalRuleIssue(diagnosticCase, draft) ??
    findSpecGuardIssue(diagnosticCase, draft, technicianOutcome) ??
    findConfirmationGuardIssue(diagnosticCase, draft, technicianOutcome) ??
    findMissingTestMetaIssue(draft)
  );
}

function findMissingTestMetaIssue(draft: {
  actionType?: string;
  diagnosticTarget?: string | null;
  diagnosticGoal?: string | null;
  testMethod?: string | null;
}): GuardIssue | null {
  if (draft.actionType !== "TEST") return null;
  const missing: string[] = [];
  if (!draft.diagnosticTarget?.trim()) missing.push("diagnosticTarget");
  if (!draft.diagnosticGoal?.trim()) missing.push("diagnosticGoal");
  if (!draft.testMethod?.trim()) missing.push("testMethod");
  if (missing.length === 0) return null;
  return issue(
    "TEST_META",
    `TEST metadata nedostaje (${missing.join(", ")}). Dodaj diagnosticTarget, diagnosticGoal i testMethod.`,
  );
}
