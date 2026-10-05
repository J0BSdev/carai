import type { DiagnosticCase, Hypothesis, Observation, TechnicianOutcome } from "./types";
import { observationResultText } from "./observation";
import { findTechnicianOutcomeConsistencyIssue } from "./confirmation-guard";
import { findSafetyAndTechnicalRuleIssue } from "./safety-guard";
import type { GuardIssue } from "./guard-issue";
import { logDiagnosticUserPromptChars } from "./ai-telemetry";
import type { LlmStepPayload } from "./providers";

export const DIAGNOSTIC_SYSTEM_PROMPT = `AI dijagnostički copilot. Ti interpretiraš mechanic tekst i biraš točno jednu akciju: ASK | TEST | FINISH. Backend ne parsira tekst i ne mijenja actionType. Hrvatski. Jedan korak, bez liste.

TEST čim ima dovoljno podataka. ASK samo ako odgovor mijenja sljedeći korak.
DTC-first: knownFacts.knownDtcCodes koristi odmah. Ne rescan, ne opća lampica/simptom pitanja, ne pitaj ponovno vozilo.
Ako je sigurno i izvedivo, direktno mjerenje na granici komponente (ulaz/napajanje/masa/signal) prije upstream/indirektnog (relej, osigurač, ECU, zvuk, vizual).
technicianOutcome samo iz trenutnog RESULT.text. SKIP, CANNOT_PERFORM, REJECT_DIAGNOSIS, CONTINUE_AFTER_FINISH i originalComplaint nisu mechanic result — izostavi ga. status je samo FAULT_CONFIRMED ili REPAIR_CONFIRMED i oba traže FINISH. Nema fault polja. Ne čini spec VERIFIED.
Ne izmišljaj OEM brojke, pinove ni raspone. technicalClaims.sourceType: GENERAL_PRINCIPLE | MODEL_KNOWLEDGE | UNKNOWN. VERIFIED_* nije dozvoljen.
Živi SRS/airbag konektor ili modul, HV/narančasti kabel/inverter, ili pirotehnika: jedna rečenica što napraviti prije rada. Ostali testovi bez warninga.
FINISH: diagnosisCertainty točno SUSPECTED|LIKELY|HIGH_CONFIDENCE|CONFIRMED. CONFIRMED samo uz neovisan jak dokaz ili ovaj-turn FAULT_CONFIRMED|REPAIR_CONFIRMED. Poštuj rejectedDiagnoses.
hypotheses.status točno plausible|supported|weakened|ruled_out. confidence 0-100 opcionalno.

semanticUpdate samo kad RESULT dodaje vehicle, symptoms, DTC ili measurements, ili kad postoji technicianOutcome. dtcsAdd doslovno. measurementsAdd.raw verbatim.

JSON bez markdowna. Samo polja iz sheme. Nepoznato polje je nevaljan draft.
TEST: actionType, content, rationale, expectedResultHint. testGuide samo za nerutinski test.
ASK: actionType, content, rationale.
FINISH: actionType, content, rationale, confirmedFault, diagnosisCertainty.
{"actionType":"TEST","content":"…","rationale":"…","expectedResultHint":"…"}`;

/** Case facts serialized into prompts. Result text is raw; the model interprets it. */
export function buildCaseState(diagnosticCase: DiagnosticCase) {
  const stepHistory: Array<{
    actionType: string;
    content: string;
    result: string | null;
    kind?: Observation["kind"];
    reason?: string;
    testGuide?: string;
  }> = [];

  const extracted = diagnosticCase.extracted ?? {};
  const knownFacts = {
    vehicle: extracted.vehicle ?? null,
    knownDtcCodes: extracted.dtcs ?? [],
    symptoms: extracted.symptoms ?? [],
    measurements: (extracted.measurements ?? []).map((m) => m.trim()).filter(Boolean),
  };

  for (const step of diagnosticCase.steps) {
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    const result = observationResultText(obs);

    stepHistory.push({
      actionType: step.actionType,
      content: step.content,
      result,
      ...(obs ? { kind: obs.kind } : {}),
      ...(obs?.kind === "CANNOT_PERFORM" && obs.reason
        ? { reason: obs.reason }
        : {}),
      ...(step.testGuide ? { testGuide: step.testGuide } : {}),
    });
  }

  return {
    originalComplaint: diagnosticCase.problemText,
    knownFacts,
    currentHypotheses: latestHypotheses(diagnosticCase).map((h) => ({
      hypothesis: h.label,
      status: h.status,
      confidence: h.confidence ?? null,
    })),
    diagnosticStepHistory: stepHistory,
    rejectedDiagnoses: rejectedFromObservations(diagnosticCase),
  };
}

/** Rebuilt from REJECT_DIAGNOSIS observations and the FINISH step they point at. */
function rejectedFromObservations(diagnosticCase: DiagnosticCase) {
  const rows: Array<{ diagnosis: string; rejectedAtStep: string }> = [];
  for (const obs of diagnosticCase.observations) {
    if (obs.kind !== "REJECT_DIAGNOSIS") continue;
    const step = diagnosticCase.steps.find((s) => s.id === obs.stepId);
    const diagnosis = step?.confirmedFault?.trim() || step?.content.trim();
    if (!diagnosis) continue;
    rows.push({ diagnosis, rejectedAtStep: obs.stepId });
  }
  return rows;
}

function latestHypotheses(diagnosticCase: DiagnosticCase): Hypothesis[] {
  for (let i = diagnosticCase.steps.length - 1; i >= 0; i -= 1) {
    const hypotheses = diagnosticCase.steps[i]?.hypotheses;
    if (hypotheses && hypotheses.length > 0) return hypotheses;
  }
  return [];
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
  if (s.testGuide) row.testGuide = s.testGuide;
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
  };

  if (state.currentHypotheses.length) {
    out.currentHypotheses = state.currentHypotheses;
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
  "expectedResultHint",
  "confirmedFault",
  "diagnosisCertainty",
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

Odbij ako draft nije točno jedna ASK|TEST|FINISH, ponavlja poznato, tretira skipped kao dokaz, ne prati CASE STATE, izmišlja OEM brojku ili pin, ili opasan TEST (živi SRS, HV, pirotehnika) nema jednu praktičnu rečenicu prije rada.
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
  draft: LlmStepPayload,
  technicianOutcome?: TechnicianOutcome | null,
): GuardIssue | null {
  return (
    findTechnicianOutcomeConsistencyIssue(technicianOutcome, draft) ??
    findSafetyAndTechnicalRuleIssue(draft)
  );
}
