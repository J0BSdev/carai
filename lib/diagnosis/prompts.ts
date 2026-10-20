import type { DiagnosticCase, Hypothesis, Observation, TechnicianOutcome } from "./types";
import { formatPriorResolvedHintsForPrompt } from "@/lib/cases/prior-cases";
import { observationResultText } from "./observation";
import { findTechnicianOutcomeConsistencyIssue } from "./confirmation-guard";
import { findSafetyAndTechnicalRuleIssue } from "./safety-guard";
import { issue, type GuardIssue } from "./guard-issue";
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
Nakon svakog rezultata reevaluiraj cijeli case i ažuriraj hipoteze. Interno max 3 prema značajnim dokazima. hypotheses stavka točno {"label":"...","status":"plausible|supported|weakened|ruled_out","confidence":0-100}. confidence je procjena potkrijepljenosti dokazima, ne statistička vjerojatnost. Bez statement, cause, reason, probability, note.
TEST: kad postoje značajni dokazi, vrati compact hypotheses; test razlikuje vodeću hipotezu od relevantne alternative. ASK: hypotheses samo kad odgovor mijenja ranking. FINISH: uvijek compact hypotheses.
PRIOR_RESOLVED_CASE_CANDIDATES ako postoje: backend shortlist. Ti procijeni tehničku relevantnost (vozilo, motor, simptomi, DTC, rezultati ovog slučaja). Smiješ zanemariti sve. Samo tragovi, nikad dokaz. Ne preskači potrebne TEST. Ne diži diagnosisCertainty zbog sličnog prošlog kvara. source i diagnosisCertainty su izvorni podaci — ne pretpostavljaj tko je potvrdio kvar.

Na startu iz originalComplaint u semanticUpdate stavi samo eksplicitno navedeno: vehicle.make, vehicle.model, vehicle.year, vehicle.engine (gorivo, obujam ili oznaka), vehicle.mileage, dtcsAdd. Polje koje nije navedeno izostavi. Ne izmišljaj. Poslije semanticUpdate samo kad RESULT dodaje vehicle, symptomsAdd ili dtcsAdd, ili kad postoji technicianOutcome. dtcsAdd doslovno.

JSON bez markdowna. Samo polja iz sheme. Nepoznato polje je nevaljan draft. semanticUpdate je polje sheme.
title: kratak konkretan naslov pitanja ili testa. content: detaljnije objašnjenje i ne ponavlja title.
TEST: actionType, title, content, rationale, expectedResultHint, semanticUpdate. testGuide samo za nerutinski test.
ASK: actionType, title, content, rationale, semanticUpdate.
FINISH: actionType, content, rationale, confirmedFault, diagnosisCertainty, semanticUpdate.
{"actionType":"TEST","title":"…","content":"…","rationale":"…","expectedResultHint":"…","semanticUpdate":{"vehicle":{"make":"…","model":"…","engine":"…"}},"hypotheses":[{"label":"…","status":"supported","confidence":70},{"label":"…","status":"plausible","confidence":40}]}`;

/** Case facts serialized into prompts. Result text is raw; the model interprets it. */
export function buildCaseState(diagnosticCase: DiagnosticCase) {
  const stepHistory: Array<{
    actionType: string;
    content: string;
    result: string | null;
    kind?: Observation["kind"];
    reason?: string;
    hasPhoto?: boolean;
    testGuide?: string;
  }> = [];

  const extracted = diagnosticCase.extracted ?? {};
  const knownFacts = {
    vehicle: extracted.vehicle ?? null,
    knownDtcCodes: extracted.dtcs ?? [],
    symptoms: extracted.symptoms ?? [],
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
      ...(obs?.kind === "RESULT" && obs.hasPhoto ? { hasPhoto: true } : {}),
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
  if (s.hasPhoto) row.hasPhoto = true;
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

/** RESULT observations on accepted ASK/TEST steps. Does not read result text. */
function acceptedAskTestResultCount(diagnosticCase: DiagnosticCase): number {
  const stepIds = new Set(
    diagnosticCase.steps
      .filter((step) => step.actionType === "ASK" || step.actionType === "TEST")
      .map((step) => step.id),
  );
  return diagnosticCase.observations.filter(
    (obs) => obs.kind === "RESULT" && stepIds.has(obs.stepId),
  ).length;
}

const HYPOTHESIS_REQUIRED_LINE =
  "TEST/FINISH: hypotheses obavezne, svaka s confidence 0–100.";

function hypothesisPromptLine(diagnosticCase: DiagnosticCase): string | null {
  return acceptedAskTestResultCount(diagnosticCase) >= 2
    ? HYPOTHESIS_REQUIRED_LINE
    : null;
}

export function buildDiagnosticUserPrompt(diagnosticCase: DiagnosticCase): string {
  const hypothesisLine = hypothesisPromptLine(diagnosticCase);
  const priorLine = formatPriorResolvedHintsForPrompt(
    diagnosticCase.priorResolvedHints,
  );
  const prompt = [
    "CASE STATE:",
    JSON.stringify(compactCaseStateForPrompt(buildCaseState(diagnosticCase))),
    ...(priorLine ? ["", priorLine] : []),
    ...(hypothesisLine ? ["", hypothesisLine] : []),
  ].join("\n");

  logDiagnosticUserPromptChars(prompt.length);
  return prompt;
}

const RETRY_DRAFT_KEYS = [
  "actionType",
  "title",
  "content",
  "rationale",
  "expectedResultHint",
  "confirmedFault",
  "diagnosisCertainty",
  "testGuide",
  "semanticUpdate",
  "hypotheses",
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
  reasonCalled?: string,
): string {
  const issueLines = issues.map((item) =>
    isGuardIssue(item) ? item.message : item,
  );

  const hypothesisLine = hypothesisPromptLine(diagnosticCase);
  const priorLine = formatPriorResolvedHintsForPrompt(
    diagnosticCase.priorResolvedHints,
  );
  const instruction =
    reasonCalled === "verifier_rejected"
      ? "Verifier je odbio PREVIOUS DRAFT. Razlog je u ISSUES. Reevaluiraj cijeli CASE STATE i postojeće dokaze. Ako FINISH nije potkrijepljen, vrati TEST ili ASK. Ne označi hipotezu kao ruled_out bez dokaza. FINISH samo ako dokazi opravdavaju."
      : "Vrati ispravljeni JSON koji rješava ISSUES.";
  return [
    "CASE STATE:",
    JSON.stringify(compactCaseStateForPrompt(buildCaseState(diagnosticCase))),
    ...(priorLine ? ["", priorLine] : []),
    ...(hypothesisLine ? ["", hypothesisLine] : []),
    "",
    instruction,
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

function confidenceInRange(value: number | undefined): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

/**
 * Presence and confidence range only. Label, status and the estimate stay with the model.
 * FINISH always. TEST only after two accepted ASK/TEST results. ASK never.
 */
function findHypothesisStructureIssue(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): GuardIssue | null {
  const resultCount = acceptedAskTestResultCount(diagnosticCase);
  const required =
    draft.actionType === "FINISH" ||
    (draft.actionType === "TEST" && resultCount >= 2);
  if (!required) return null;
  const hypotheses = draft.hypotheses;
  if (
    !hypotheses?.length ||
    hypotheses.some((row) => !confidenceInRange(row.confidence))
  ) {
    return issue(
      "HYPOTHESIS",
      draft.actionType === "FINISH" && resultCount < 2
        ? "FINISH: hypotheses obavezne, svaka s confidence 0–100."
        : HYPOTHESIS_REQUIRED_LINE,
    );
  }
  return null;
}

/** Structural gates only. Semantic ranking of hypotheses stays with the model. */
export function findDraftQualityIssue(
  draft: LlmStepPayload,
  technicianOutcome: TechnicianOutcome | null | undefined,
  diagnosticCase: DiagnosticCase,
): GuardIssue | null {
  return (
    findTechnicianOutcomeConsistencyIssue(technicianOutcome, draft) ??
    findSafetyAndTechnicalRuleIssue(draft) ??
    findHypothesisStructureIssue(diagnosticCase, draft)
  );
}
