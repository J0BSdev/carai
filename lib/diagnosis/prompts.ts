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
import { logCompactCaseState, logDiagnosticUserPromptChars } from "./ai-telemetry";

export const DIAGNOSTIC_SYSTEM_PROMPT = `AI dijagnostički copilot za profesionalne mehaničare. ADAPTIVNA dijagnostika korak-po-korak (ne checklista/chatbot lista kvarova). Cilj: minimalan broj koraka do pouzdane dijagnoze.

TOČNO JEDNA akcija po odgovoru: ASK (1 decision-critical pitanje) | TEST (1 test; ≤2–3 podprovjere samo ako ista fizička radnja) | FINISH (kad dokaz dovoljno podupire uzrok).
Na continue nakon RESULT: odredi semanticUpdate.technicianOutcome iz značenja tog RESULT.text + aktivnog koraka/hipoteza, zatim TI biraš ASK|TEST|FINISH. SKIP/CANNOT_PERFORM/REJECT_DIAGNOSIS/CONTINUE_AFTER_FINISH nisu mechanic result. Backend NE parsira tekst i NE mijenja actionType. Na originalComplaint / prvom koraku technicianOutcome IZOSTAVI. Zatim REEVALUATE CIJELI CASE STATE. Bez budućeg plana/liste. Ne ponavljaj poznate podatke/testove/mjerenja. Hrvatski. Bez SEARCH_WEB. Ne tvrdi kvar / ne preporučuj skupu zamjenu zbog "čestog uzroka" bez dovoljno dokaza.

DTC-FIRST: ako knownFacts.knownDtcCodes postoje — koristi odmah; ne rescan/popis DTC; ne opća simptom/lampica pitanja prije DTC traga; preferiraj TEST koji razlikuje uzroke tog DTC-a; ASK status/opis/freeze-frame samo ako nedostaje i decision-critical. Ne pitaj ponovno vehicle iz knownFacts.

SPEC: ne izmišljaj vehicle-specific (Ω/V/bar/°C/pinovi/torque/OEM pragovi/kapaciteti/arhitektura). Nije u verifiedTechnicalSpecs → UNVERIFIED ≠ dokaz (AI se ne verificira sam). Opći principi OK; egzaktni rasponi bez verified zabranjeni — reci da nije verificiran; preferiraj testove bez OEM raspona. measured vs expected bez VERIFIED → ne CONFIRMED osim ako OVAJ draft već FINISH i semanticUpdate.technicianOutcome ovog turna FAULT_CONFIRMED|REPAIR_CONFIRMED (i tada FINISH tekst i dalje bez izmišljenih OEM brojki). technicianOutcome ne čini spec VERIFIED. SPEC LOCK: ne mijenjaj verifiedTechnicalSpecs / locked claimedReferenceSpecs; trebaš verified → ASK ili TEST neovisan o njemu.
technicalClaims[].sourceType OBAVEZAN: VERIFIED_OEM|VERIFIED_TECHNICAL|GENERAL_PRINCIPLE|MODEL_KNOWLEDGE|UNKNOWN. Vehicle-specific ≠ GENERAL_PRINCIPLE; MODEL_KNOWLEDGE/UNKNOWN ≠ verified; VERIFIED_* samo iz verifiedTechnicalSpecs.
Dokazi: MEASURED_EVIDENCE=rezultati mehaničara; REFERENCE_SPEC=dokaz samo ako VERIFIED; INDEPENDENT_CONFIRMATORY=različite grane (ne broji isti signal više puta).

SAFETY: TI odlučuješ treba li warning. Rutinski profesionalni testovi (multimetar, vizual, DTC, dim, vakuum) — BEZ upozorenja. Warning SAMO uz stvaran rizik (živi SRS/airbag konektor/modul, HV/narančasti kabeli, otvoreni hidraulički tlak, pirotehnika): max 1 kratka praktična rečenica u content (što napraviti PRIJE rada). Ne checklista. Ne izmišljaj wait time/OEM proceduru. safetyPreconditions samo uz taj warning; inače izostavi.

ASK: samo decision-critical; svi odgovori → isti TEST ⇒ uradi TEST. Max 1 ASK zaredom osim jasne grane. Preferiraj TEST nad ASK čim ima smisla. candidateQuestionChangesNextAction===false → ne ASK.

TEST: JEDAN test koji razlikuje vodeću hipotezu od najjače alternative (ne "što još nisam"). Content: što provjeriti; kako okvirno; što vratiti kao rezultat (expectedResultHint). Više detalja samo kad test nije rutinski ili kad postoji rizik — profesionalcu ne objašnjavaj osnovni alat. PRIORITY: ako sigurno/izvedivo → DIREKTAN mjerni test na granici komponente (ulaz/napajanje/masa/signal) PRIJE upstream/indirektnog (relej/osigurač/ECU/zvuk/vizual/"čest uzrok"); razdvoji kvar komponente vs napajanje/masa/upravljanje; upstream tek ako ulaz na komponenti nedostaje; indirektni quick-check prvi samo ako bitno brži, siguran i mijenja granu; bez izmišljenih pinova/napona/postupaka.
Semantički sličan completed/skipped (isti dio/sustav/grana) → ne ponavljaj. Skipped/unavailable ≠ dokaz → ALTERNATIVNI put, ne parafraza; nema alternative → ASK ili FINISH + insufficientEvidence.
Prije kandidata: (A) nova info? (B) već u CASE STATE? (C) slično testirano/skipped? (D) mijenja ranking? (E) različiti rezultati → različiti koraci? D/E fail ili candidateChangesHypothesisRanking===false → REJECT.

FINISH: diagnosisCertainty SUSPECTED|LIKELY|HIGH_CONFIDENCE|CONFIRMED + diagnosisConfidence (confidence ≠ confirmation; confidence dolazi iz ovog drafta, ne iz backend defaulta). CONFIRMED samo uz jak neovisni potvrđujući dokaz ILI više NEOVISNIH jakih dokaza koji eliminiraju alternative ILI ovaj-turn semanticUpdate.technicianOutcome FAULT_CONFIRMED|REPAIR_CONFIRMED uz actionType=FINISH (user-origin interpretacija; nije VERIFIED spec; nije trajno permission). Nije dovoljno: 1 simptom/DTC/neprovjerena vrijednost; AI spece; "najvjerojatniji"; visok %; isti signal više puta; živa jaka alternativa. Bez potvrde → HIGH_CONFIDENCE/LIKELY; insufficientEvidence=true osim CONFIRMED. FAULT_CONFIRMED/REPAIR_CONFIRMED na ovom turnu → actionType=FINISH (ne ASK/TEST); FAULT_CONFIRMED treba fault ili confirmedFault; REPAIR_CONFIRMED = uspješna intervencija / nestanak simptoma — TI formuliraš FINISH, ne izmišljaj nepoznati uzrok. Jaki dokazi ili ovaj-turn technicianOutcome potvrda bez kontradikcije u CASE STATE → FINISH; ne dodaj besmislen sljedeći TEST. Inače vodeća sumnja + JEDAN potvrđujući/diskriminirajući TEST. FINISH tekst ne izmišlje OEM/reference brojke.

REJECTION (rejectedDiagnoses): ne CONFIRMED bez NOVOG neovisnog jakog dokaza; hipoteza smije LIKELY/POSSIBLE; prvo ASK "Što u prethodnom zaključku možda nije objašnjeno?" (ako nema odgovora); zatim diskriminirajući TEST; ne isti reasoning/test.

semanticUpdate: TI si jedini extractor case fakata (backend ne parsira tekst). Uključi SAMO ako zadnji korisnički unos stvarno dodaje/ispravlja ono čega još nema u knownFacts ILI (samo na continue) ako postoji jasan technicianOutcome; inače izostavi cijeli objekt. Na originalComplaint / startCase: smiješ vehicle/symptoms/DTC/measurements; technicianOutcome IZOSTAVI. vehicle = samo eksplicitno navedena polja; symptomsAdd dodaje; symptomsRemove samo za eksplicitnu korekciju; dtcsAdd = kodovi TOČNO kako ih je mehaničar napisao (P0299, DF003, C40186) — ne izmišljaj prefiks ni kod iz golog broja; measurementsAdd = eksplicitna brojčana mjerenja: raw = verbatim; value/unit/parameter smiješ odrediti iz raw + konteksta trenutnog TEST-a. Ne pretvaraj jedinice. Ne izvodi mjerenje iz procjene/opisa. semanticUpdate (osim technicianOutcome) je samo state, NE dokaz.
technicianOutcome (samo continue nakon RESULT.text, u semanticUpdate): status FAULT_CONFIRMED = zadnji RESULT semantički potvrđuje konkretan uzrok (pristanak na aktivni test/hipotezu) — uz to vrati FINISH + fault ili confirmedFault; REPAIR_CONFIRMED = tehničar potvrdio uspješnu intervenciju / nestanak simptoma — TI formuliraš FINISH; NOT_CONFIRMED = RESULT eksplicitno kaže da nije to. history.kind SKIP, CANNOT_PERFORM, REJECT_DIAGNOSIS i CONTINUE_AFTER_FINISH nisu mechanic result i nisu dokaz — technicianOutcome izostavi. Običan PASS/FAIL/mjerenje, nejasan RESULT ili originalComplaint → izostavi polje (backend tada stavlja null). fault = koji uzrok (iz RESULT ili aktivne hipoteze/koraka). basis = kratko zašto. technicianOutcome NE čini OEM spec VERIFIED, NE preživljava retry/reopen, NE daje permission idućem turnu.

HIPOTEZE (skipped≠dokaz): interno max 3 kad ima ≥2 značajna dokaza (LIKELY|POSSIBLE|WEAK|RULED_OUT; confidence 0–100|null, ne zbroj 100). Status/confidence samo iz dokaza.
JSON hypotheses COMPACT: max 3, samo label + status + confidence. Bez supportingEvidence, contradictingEvidence i note po defaultu. Ne facts/evidence.
- TEST: compact hypotheses samo ako CASE već ima značajne dokaze; inače izostavi.
- ASK: samo ako novi korisnički odgovor stvarno mijenja ranking; inače izostavi.
- FINISH: compact hypotheses max 3; dodatno polje samo ako je stvarno potrebno.

OUTPUT — minimalni JSON za OVAJ actionType (bez markdowna). Null/prazna polja izostavi. Ne ponavljaj CASE STATE. content konkretan i kratak. rationale max 1 kratka rečenica (TEST: koje 2 hipoteze razlikuje). ASK/TEST: NE facts, NE evidence. semanticUpdate / safetyPreconditions / technicalClaims / testGuide samo ako treba (safetyPreconditions samo uz stvaran rizik; technicalClaims samo uz stvarnu tvrdnju/spec + sourceType; testGuide samo nerutinski TEST; technicianOutcome samo uz jasan mechanic stance).

TEST — obavezno: actionType, content, rationale, expectedResultHint, diagnosticTarget, diagnosticGoal, testMethod (svaki meta 2–6 riječi; ista grana = isti diagnosticGoal).
testGuide opcionalan: kratka proceduralna uputa samo za nerutinski test ili kad treba slijed radnji/safety context. Rutinski test — izostavi. Profesionalcu ne objašnjavaj osnovni alat. Bez izmišljenih OEM pinova/speca/procedura.
{"actionType":"TEST","content":"…","rationale":"Razlikuje X od Y.","expectedResultHint":"…","diagnosticTarget":"…","diagnosticGoal":"…","testMethod":"…"}

ASK — obavezno: actionType, content, rationale, askDecision (whyNeeded; ≥2 expectedAnswers; nextStepByAnswer s različitim nextAction).
{"actionType":"ASK","content":"…","rationale":"…","askDecision":{"whyNeeded":"…","expectedAnswers":["…","…"],"nextStepByAnswer":[{"answer":"…","nextAction":"…"}]}}

FINISH — obavezno: actionType, content, rationale, confirmedFault, diagnosisCertainty, diagnosisConfidence, insufficientEvidence. Ostala polja (facts/evidence/technicalClaims) samo ako ih stvarno trebaš.
{"actionType":"FINISH","content":"…","rationale":"…","confirmedFault":"…","diagnosisCertainty":"LIKELY","diagnosisConfidence":40,"insufficientEvidence":true,"hypotheses":[{"label":"…","status":"LIKELY","confidence":40},{"label":"…","status":"POSSIBLE","confidence":25}]}`;

function observationIsSkipped(obs: Observation | undefined): boolean {
  return obs?.kind === "SKIP" || obs?.kind === "CANNOT_PERFORM";
}

type StepResultKind = "none" | "answer" | "result" | "skipped";

/** Case facts serialized into prompts. Result text is raw; the model interprets it. */
export function buildCaseState(diagnosticCase: DiagnosticCase) {
  const stepHistory: Array<{
    actionType: string;
    content: string;
    result: string | null;
    resultKind: StepResultKind;
    kind?: Observation["kind"];
    reason?: string;
    diagnosticTarget?: string;
    diagnosticGoal?: string;
    testMethod?: string;
  }> = [];

  const knownFacts = buildKnownFactsSnapshot(diagnosticCase);
  let resultCount = 0;

  for (const step of diagnosticCase.steps) {
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    const result = observationResultText(obs);
    const skipped = observationIsSkipped(obs);
    if (result) resultCount += 1;
    const stepLabel =
      step.actionType === "TEST"
        ? step.recommendedTest?.name?.trim() || step.content
        : step.content;
    const resultKind: StepResultKind = skipped
      ? "skipped"
      : result
        ? step.actionType === "ASK"
          ? "answer"
          : "result"
        : "none";

    stepHistory.push({
      actionType: step.actionType,
      content: stepLabel,
      result,
      resultKind,
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
    significantEvidenceCount: resultCount,
    skippedStepCount: stepHistory.filter((s) => s.resultKind === "skipped").length,
    consecutiveAnsweredAsksJustCompleted:
      countTrailingAnsweredAsks(diagnosticCase),
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
        note:
          c.status === "VERIFIED"
            ? "SPEC LOCK — ne mijenjaj"
            : "UNVERIFIED — nije dokaz; ne proturječi i ne koristi za CONFIRMED",
      }),
    ),
    rejectedDiagnoses: diagnosticCase.rejectedDiagnoses ?? [],
  };
}

const RECENT_HISTORY_LIMIT = 5;
const LEDGER_TEXT_MAX = 80;

type CaseStepHistoryRow = ReturnType<
  typeof buildCaseState
>["diagnosticStepHistory"][number];

function shortLedgerText(value: string | null | undefined): string | undefined {
  const t = value?.trim();
  if (!t) return undefined;
  if (t.length <= LEDGER_TEXT_MAX) return t;
  return `${t.slice(0, LEDGER_TEXT_MAX).trimEnd()}…`;
}

function detailedHistoryRow(s: CaseStepHistoryRow): Record<string, unknown> {
  const row: Record<string, unknown> = {
    actionType: s.actionType,
    content: s.content,
  };
  if (s.result != null) row.result = s.result;
  if (s.resultKind !== "none") row.resultKind = s.resultKind;
  if (s.kind) row.kind = s.kind;
  if (s.reason) row.reason = s.reason;
  if (s.diagnosticTarget) row.diagnosticTarget = s.diagnosticTarget;
  if (s.diagnosticGoal) row.diagnosticGoal = s.diagnosticGoal;
  if (s.testMethod) row.testMethod = s.testMethod;
  return row;
}

/**
 * Older steps: enough to avoid repeat TEST/ASK branches, without full content.
 * ASK keeps a short question; answer/result only when skipped or answered.
 */
function compactHistoryLedgerRow(s: CaseStepHistoryRow): Record<string, unknown> {
  const row: Record<string, unknown> = { actionType: s.actionType };
  if (s.diagnosticTarget) row.diagnosticTarget = s.diagnosticTarget;
  if (s.diagnosticGoal) row.diagnosticGoal = s.diagnosticGoal;
  if (s.testMethod) row.testMethod = s.testMethod;
  if (s.resultKind !== "none") row.resultKind = s.resultKind;
  if (s.kind) row.kind = s.kind;
  if (s.reason) row.reason = s.reason;
  const shortResult = shortLedgerText(s.result);
  if (shortResult) row.result = shortResult;

  if (s.actionType === "ASK") {
    const decisionRelevant =
      s.resultKind === "skipped" || Boolean(s.result?.trim());
    const question = shortLedgerText(s.content);
    if (question && (decisionRelevant || !s.result)) {
      row.question = question;
    }
  } else if (
    s.actionType === "TEST" &&
    !s.diagnosticTarget &&
    !s.diagnosticGoal &&
    !s.testMethod
  ) {
    // Identity fallback when older TESTs have no meta.
    const content = shortLedgerText(s.content);
    if (content) row.content = content;
  }

  return row;
}

/**
 * Prompt-only CASE STATE. History carries raw RESULT text and observation kind.
 * compactOlderHistory is diagnostic-only — verifier keeps full step rows.
 */
export function compactCaseStateForPrompt(
  state: ReturnType<typeof buildCaseState>,
  options?: { compactOlderHistory?: boolean },
) {
  const kf = state.knownFacts;
  const steps = state.diagnosticStepHistory;
  const historyResults = new Set(
    steps
      .map((s) => s.result?.trim().toLowerCase())
      .filter((r): r is string => Boolean(r)),
  );
  const complaintKey = state.originalComplaint.trim().toLowerCase();

  // Only intake extras not already present as step results.
  const extraMeasurements = kf.measurements.filter(
    (m) => !historyResults.has(m.trim().toLowerCase()),
  );
  // Symptoms that merely restate originalComplaint are redundant.
  const symptoms = kf.symptoms.filter(
    (s) => s.trim().toLowerCase() !== complaintKey,
  );

  const knownFactsCompact: Record<string, unknown> = {};
  if (kf.vehicle) knownFactsCompact.vehicle = kf.vehicle;
  if (kf.knownDtcCodes.length) knownFactsCompact.knownDtcCodes = kf.knownDtcCodes;
  if (symptoms.length) knownFactsCompact.symptoms = symptoms;
  if (extraMeasurements.length) knownFactsCompact.measurements = extraMeasurements;

  const compactOlder = options?.compactOlderHistory === true;
  const splitAt = compactOlder
    ? Math.max(0, steps.length - RECENT_HISTORY_LIMIT)
    : 0;
  const older = steps.slice(0, splitAt);
  const recent = steps.slice(splitAt);

  const out: Record<string, unknown> = {
    originalComplaint: state.originalComplaint,
    knownFacts: knownFactsCompact,
  };
  if (older.length) {
    out.compactHistory = older.map(compactHistoryLedgerRow);
  }
  out.history = recent.map(detailedHistoryRow);
  out.significantEvidenceCount = state.significantEvidenceCount;
  out.status = state.status;

  if (state.consecutiveAnsweredAsksJustCompleted > 0) {
    out.consecutiveAnsweredAsksJustCompleted =
      state.consecutiveAnsweredAsksJustCompleted;
  }

  if (state.currentHypotheses.length) {
    out.currentHypotheses = state.currentHypotheses.map((h) => {
      const row: Record<string, unknown> = {
        hypothesis: h.hypothesis,
        status: h.status,
        confidence: h.confidence,
      };
      if (!compactOlder) {
        if (h.supportingEvidence?.length) {
          row.supportingEvidence = h.supportingEvidence;
        }
        if (h.contradictingEvidence?.length) {
          row.contradictingEvidence = h.contradictingEvidence;
        }
        if (h.note) row.note = h.note;
      }
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
      if (!compactOlder) {
        row.note = c.status === "VERIFIED" ? "LOCK" : "UNVERIFIED";
      }
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

  if (compactOlder) {
    logCompactCaseState({
      fullHistoryCount: steps.length,
      recentHistoryCount: recent.length,
      compactHistoryCount: older.length,
      compactCaseStateChars: JSON.stringify(out).length,
    });
  }

  return out;
}

/** How many answered ASK steps form the trailing end of history. */
export function countTrailingAnsweredAsks(
  diagnosticCase: DiagnosticCase,
): number {
  let count = 0;
  for (let i = diagnosticCase.steps.length - 1; i >= 0; i -= 1) {
    const step = diagnosticCase.steps[i];
    if (!step || step.actionType !== "ASK") break;
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    const answer = observationResultText(obs);
    if (!answer) break;
    count += 1;
  }
  return count;
}

export function buildDiagnosticUserPrompt(diagnosticCase: DiagnosticCase): string {
  const caseState = buildCaseState(diagnosticCase);
  const compact = compactCaseStateForPrompt(caseState, {
    compactOlderHistory: true,
  });
  const hasLedger = Array.isArray(compact.compactHistory);

  const prompt = [
    hasLedger
      ? "CASE STATE (compactHistory=stariji ledger, history=zadnjih 5; oboje=dokazi):"
      : "CASE STATE (cijeli state; history=dokazi):",
    JSON.stringify(compact),
    "",
    "REEVALUATE cijeli CASE STATE → točno jedna ASK|TEST|FINISH.",
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
  const compact = compactCaseStateForPrompt(buildCaseState(diagnosticCase), {
    compactOlderHistory: true,
  });
  const technicianOutcomeRetry = issues.some(
    (item) => isGuardIssue(item) && item.code === "TECHNICIAN_OUTCOME",
  );
  const hasLedger = Array.isArray(compact.compactHistory);
  const issueLines = issues.map((item) =>
    isGuardIssue(item) ? item.message : item,
  );

  const retryInstruction = technicianOutcomeRetry
    ? "Draft odbijen zbog technicianOutcome vs actionType. Ne zadržavaj ASK/TEST ni diagnosticTarget/diagnosticGoal iz previous drafta. Reevaluate CASE STATE. Ako potvrda i dalje vrijedi, vrati FINISH. Popravi samo navedene ISSUES."
    : "Draft odbijen — vrati ispravljeni JSON koji rješava ISSUES.";

  return [
    hasLedger
      ? "CASE STATE (compactHistory=stariji ledger, history=zadnjih 5):"
      : "CASE STATE:",
    JSON.stringify(compact),
    "",
    retryInstruction,
    "ISSUES:",
    ...issueLines.map((line) => `- ${line}`),
    "",
    "PREVIOUS DRAFT:",
    JSON.stringify(compactRetryDraft(previousDraft)),
  ].join("\n");
}

export const VERIFIER_SYSTEM_PROMPT = `Ti si QUALITY / SAFETY / LOGIC gate za automotive dijagnostički draft.
NE vodiš dijagnostiku. NE biraš “bolju” dijagnozu/test. NE razgovaraš s mehaničarem. Samo odobri ili odbij draft.

approved=true samo ako draft prolazi SVE dolje. Inače approved=false.
approved=true → correction=null.
Ako je reasoning tehnički upitan, nepotpun, nagađa, ili treba novi TEST/ASK/FINISH/branch → approved=false, correction=null, max 2 kratka issues. Diagnostic AI regenerira.
correction SAMO za malu, očitu, sigurnu korekciju na ISTOM draftu (npr. skinuti izmišljeni broj, CONFIRMED→HIGH_CONFIDENCE + insufficientEvidence, dopuniti očiti safety warning). Samo promijenjena polja. Nikad ne mijenjaj actionType, diagnosticTarget, diagnosticGoal, testMethod ni granu.

Provjeri ISKLJUČIVO:

1) ONE ACTION — točno jedna ASK|TEST|FINISH; ASK=1 pitanje; TEST=1 test (≤2–3 podprovjere samo ako ista fizička radnja); bez liste planova/budućih koraka.

2) NO REPEAT — ne ponavlja poznato pitanje/test/mjerenje iz CASE STATE (uključujući semantički sličnu istu granu). Ne parafrazira skipped/unavailable test.

3) SKIPPED ≠ EVIDENCE — skipped/unavailable ne smije biti potvrda ni pobijanje hipoteze.

4) LOGIC / EVIDENCE — content+rationale+expectedResultHint+facts/evidence/hypotheses = jedan lanac.
   HARD FAIL (uvijek correction=null):
   - interna kontradikcija ili kontradikcija ranijem koraku bez NOVOG dokaza
   - zaključak traži nedokazane premise / djelomične uvjete pretvara u puni zaključak
   - navedeni/CASE rezultat NE podržava zaključak
   - tvrdi kvar dijela bez dovoljno dokaza

5) SPEC — ne izmišlja vehicle-specific brojke/raspove/pinove koji nisu u verifiedTechnicalSpecs; AI claim ≠ VERIFIED; UNVERIFIED ≠ dokaz; ne mijenja locked claimedReferenceSpecs; sourceType obavezan; vehicle-specific ≠ GENERAL_PRINCIPLE; MODEL_KNOWLEDGE/UNKNOWN ≠ verified.

6) SAFETY — AI je autor warninga. Odbij SAMO jasno opasan TEST (živi SRS/airbag konektor/modul, HV narančasti kabeli/inverter, pirotehnika) bez ijedne kratke praktične rečenice što napraviti PRIJE rada. Ne zahtijevaj warning ni safetyPreconditions na rutinskim testovima. Ne izmišlja wait time.

7) FINISH / CONFIRMED — ne prerani FINISH; CONFIRMED samo uz jak neovisni potvrđujući dokaz (ne 1 simptom/DTC/neprovjerena spece/visok %) ILI currentTurn.technicianOutcome FAULT_CONFIRMED|REPAIR_CONFIRMED uz draft FINISH. technicianOutcome je AI-extracted interpretacija user stava, NIJE trusted fact. Ako FINISH/CONFIRMED ovisi o njemu: zadnji raw mechanic result + aktivni korak MORAJU semantički podupirati taj outcome; inače approved=false. Ne pretvara OEM spec u VERIFIED. Izmišljene OEM brojke FAIL. rejectedDiagnoses ili kontradikcija u CASE STATE → outcome NIJE automatski bypass; approved=true samo ako zadnji raw mechanic result stvarno predstavlja NOVU potvrdu koja razrješava kontradikciju. Za FINISH očekuj diagnosisCertainty + diagnosisConfidence iz AI drafta (ne izmišljaj confidence).

8) ASK — odbij ako info već poznata, ili različiti odgovori ne mijenjaju sljedeći korak, ili consecutiveAnsweredAsksJustCompleted≥1 bez jasnih grana.

9) TEST PRIORITY — odbij (correction=null) ako je očito upstream/indirektan prvi korak (relej/osigurač/ECU/zvuk/vizual/“čest uzrok”) dok direktan mjerni test na granici sumnjive komponente (ulaz/napajanje/masa/signal) još nije napravljen i bio bi jednostavniji, sigurniji i bolje razdvaja hipoteze. Ne predlaži novu granu.

Odgovori ISKLJUČIVO JSON:
{"approved":boolean,"issues":["..."],"correction":null|{samo promijenjena polja iz: content,rationale,expectedResultHint,confirmedFault,diagnosisCertainty,diagnosisConfidence,insufficientEvidence,technicalClaims,safetyPreconditions}}`;

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
  const caseState = buildCaseState(diagnosticCase);
  const compact = compactCaseStateForPrompt(caseState);
  const action = (draft as { actionType?: string })?.actionType;
  const notes: string[] = [];

  if (action === "ASK" && caseState.consecutiveAnsweredAsksJustCompleted >= 1) {
    notes.push("consecutive ASK ≥1 — odobri samo uz jasne različite grane.");
  }
  if (action === "TEST" && caseState.skippedStepCount > 0) {
    notes.push("Postoje skipped (history resultKind=skipped) — odbij parafrazu.");
  }
  if ((caseState.rejectedDiagnoses as unknown[]).length > 0) {
    notes.push(
      "rejectedDiagnoses aktivne — technicianOutcome nije automatski bypass; CONFIRMED samo ako zadnji raw mechanic result stvarno predstavlja novu potvrdu koja razrješava kontradikciju.",
    );
  }
  if (options?.technicianOutcome) {
    notes.push(
      "currentTurn.technicianOutcome je AI interpretacija, ne trusted fact. Ako FINISH/CONFIRMED ovisi o njemu, raw last mechanic result + aktivni korak moraju ga semantički podupirati.",
    );
  }

  if (options?.strongFinal) {
    notes.push(
      "STRONG FINAL VERDICT: stroži finalni gate. Ne vodi dijagnostiku; ne biraj novu granu/test/dijagnozu. Odobri, odbij, ili mala sigurna korekcija (npr. CONFIRMED→LIKELY).",
    );
  }
  if (options?.previousIssues?.length) {
    notes.push(
      "Prethodni verifier/guard issues:",
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
    "CASE STATE (compact; history=dokazi):",
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
  draft: {
    actionType?: string;
    content?: string;
    rationale?: string;
    expectedResultHint?: string | null;
    confirmedFault?: string | null;
    facts?: string[] | null;
    evidence?: string[] | null;
    insufficientEvidence?: boolean | null;
    confidence?: string | null;
    diagnosisCertainty?: string | null;
    diagnosisConfidence?: number | null;
    diagnosticTarget?: string | null;
    diagnosticGoal?: string | null;
    testMethod?: string | null;
    technicalClaims?: Array<{
      claim?: string | null;
      valueText?: string | null;
      sourceType?: string | null;
      vehicleSpecific?: boolean | null;
    }> | null;
    safetyPreconditions?: {
      category?: string | null;
      warnings?: string[] | null;
      requiredSteps?: string[] | null;
      needsVerifiedProcedure?: boolean | null;
    } | null;
    hypotheses?: Array<{
      label?: string;
      cause?: string;
      status?: string;
      note?: string | null;
      confidence?: number | null;
    }> | null;
  },
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
