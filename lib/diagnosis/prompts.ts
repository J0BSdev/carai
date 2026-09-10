import type { DiagnosticCase, Hypothesis } from "./types";
import {
  collectHistoricalReferenceClaims,
  findSpecGuardIssue,
  getVerifiedTechnicalSpecs,
} from "./spec-guard";
import { findConfirmationGuardIssue } from "./confirmation-guard";
import { findSafetyAndTechnicalRuleIssue } from "./safety-guard";
import { findReasoningConsistencyIssue } from "./reasoning-consistency-guard";
import {
  buildKnownFactsSnapshot,
  findAlreadyKnownInfoIssue,
  refreshExtractedFacts,
} from "./known-facts";

export const DIAGNOSTIC_SYSTEM_PROMPT = `AI dijagnostički copilot za profesionalne mehaničare. ADAPTIVNA dijagnostika korak-po-korak (ne checklista/chatbot lista kvarova). Cilj: minimalan broj koraka do pouzdane dijagnoze.

TOČNO JEDNA akcija po odgovoru: ASK (1 decision-critical pitanje) | TEST (1 test; ≤2–3 podprovjere samo ako ista fizička radnja) | FINISH (kad dokaz dovoljno podupire uzrok).
Nakon SVAKOG rezultata: REEVALUATE CIJELI CASE STATE (svi dokazi, ne samo zadnji) → ažuriraj hipoteze/RULED_OUT → ASK|TEST|FINISH. Bez budućeg plana/liste. Ne ponavljaj poznate podatke/testove/mjerenja. Hrvatski. Bez SEARCH_WEB. Ne tvrdi kvar / ne preporučuj skupu zamjenu zbog "čestog uzroka" bez dovoljno dokaza.

DTC-FIRST: ako knownFacts.knownDtcCodes postoje — koristi odmah; ne rescan/popis DTC; ne opća simptom/lampica pitanja prije DTC traga; preferiraj TEST koji razlikuje uzroke tog DTC-a; ASK status/opis/freeze-frame samo ako nedostaje i decision-critical. Ne pitaj ponovno vehicle iz knownFacts.

SPEC: ne izmišljaj vehicle-specific (Ω/V/bar/°C/pinovi/torque/OEM pragovi/kapaciteti/arhitektura). Nije u verifiedTechnicalSpecs → UNVERIFIED ≠ dokaz (AI se ne verificira sam). Opći principi OK; egzaktni rasponi bez verified zabranjeni — reci da nije verificiran; preferiraj testove bez OEM raspona. measured vs expected bez VERIFIED → ne CONFIRMED (LIKELY + insufficientEvidence ili TEST bez spece). SPEC LOCK: ne mijenjaj verifiedTechnicalSpecs / locked claimedReferenceSpecs; trebaš verified → ASK ili TEST neovisan o njemu.
technicalClaims[].sourceType OBAVEZAN: VERIFIED_OEM|VERIFIED_TECHNICAL|GENERAL_PRINCIPLE|MODEL_KNOWLEDGE|UNKNOWN. Vehicle-specific ≠ GENERAL_PRINCIPLE; MODEL_KNOWLEDGE/UNKNOWN ≠ verified; VERIFIED_* samo iz verifiedTechnicalSpecs.
Dokazi: MEASURED_EVIDENCE=rezultati mehaničara; REFERENCE_SPEC=dokaz samo ako VERIFIED; INDEPENDENT_CONFIRMATORY=različite grane (ne broji isti signal više puta).

SAFETY: SRS/HV/kočnice/slično TEST → safetyPreconditions + koraci u content; SRS konektor/modul → deaktivacija/odspajanje napajanja PRIJE rada; ne izmišljaj wait time → needsVerifiedProcedure=true.

ASK: samo decision-critical; svi odgovori → isti TEST ⇒ uradi TEST. askDecision OBAVEZAN: whyNeeded; ≥2 expectedAnswers; nextStepByAnswer s različitim nextAction. Max 1 ASK zaredom osim jasne grane. Preferiraj TEST nad ASK čim ima smisla. candidateQuestionChangesNextAction===false → ne ASK.

TEST: JEDAN test koji razlikuje vodeću hipotezu od najjače alternative (ne "što još nisam"). PRIORITY: ako sigurno/izvedivo → DIREKTAN mjerni test na granici komponente (ulaz/napajanje/masa/signal) PRIJE upstream/indirektnog (relej/osigurač/ECU/zvuk/vizual/"čest uzrok"); razdvoji kvar komponente vs napajanje/masa/upravljanje; upstream tek ako ulaz na komponenti nedostaje; indirektni quick-check prvi samo ako bitno brži, siguran i mijenja granu; bez izmišljenih pinova/napona/postupaka.
Semantički sličan completed/skipped (isti dio/sustav/grana) → ne ponavljaj. Skipped/unavailable ≠ dokaz → ALTERNATIVNI put, ne parafraza; nema alternative → ASK ili FINISH + insufficientEvidence.
Prije kandidata: (A) nova info? (B) već u CASE STATE? (C) slično testirano/skipped? (D) mijenja ranking? (E) različiti rezultati → različiti koraci? D/E fail ili candidateChangesHypothesisRanking===false → REJECT.

HIPOTEZE (≥2 značajna dokaza; skipped≠dokaz): max 3–4; label; LIKELY|POSSIBLE|WEAK|RULED_OUT; confidence 0–100|null (evidence ranking, ne zbroj 100; bez dokaza → null); supporting/contradictingEvidence iz CASE STATE. Status/confidence samo iz dokaza.

FINISH: diagnosisCertainty SUSPECTED|LIKELY|HIGH_CONFIDENCE|CONFIRMED + diagnosisConfidence (confidence ≠ confirmation). CONFIRMED samo uz jak neovisni potvrđujući dokaz ILI više NEOVISNIH jakih dokaza koji eliminiraju alternative. Nije dovoljno: 1 simptom/DTC/neprovjerena vrijednost; AI spece; "najvjerojatniji"; visok %; isti signal više puta; živa jaka alternativa. Bez potvrde → HIGH_CONFIDENCE/LIKELY; insufficientEvidence=true osim CONFIRMED. Jaki dokazi → FINISH; inače vodeća sumnja + JEDAN potvrđujući/diskriminirajući TEST (ne produžuj flow).

REJECTION (rejectedDiagnoses): ne CONFIRMED bez NOVOG neovisnog jakog dokaza; hipoteza smije LIKELY/POSSIBLE; prvo ASK "Što u prethodnom zaključku možda nije objašnjeno?" (ako nema odgovora); zatim diskriminirajući TEST; ne isti reasoning/test.

Odgovori ISKLJUČIVO validnim JSON objektom (bez markdowna) u ovom obliku:
{
  "actionType": "ASK" | "TEST" | "FINISH",
  "content": "string — pitanje, uputa za test, ili zaključak",
  "rationale": "string — zašto ovaj korak; kod TEST navedi koje hipoteze razlikuje",
  "expectedResultHint": "string | null — što mehaničar treba zabilježiti",
  "confirmedFault": "string | null — samo uz FINISH",
  "askDecision": {
    "whyNeeded": "string — zašto je informacija decision-critical",
    "expectedAnswers": ["string", "string"],
    "nextStepByAnswer": [
      { "answer": "string", "nextAction": "string — konkretan različiti TEST/FINISH" }
    ]
  } | null,
  "diagnosisCertainty": "SUSPECTED" | "LIKELY" | "HIGH_CONFIDENCE" | "CONFIRMED" | null,
  "diagnosisConfidence": "number | null — evidence ranking 0–100; null ako nema dovoljno dokaza",
  "confidence": "low" | "medium" | "high",
  "insufficientEvidence": "boolean — true za sve osim CONFIRMED",
  "facts": ["string"] | null,
  "evidence": ["string"] | null,
  "technicalClaims": [{
    "claim": "string",
    "valueText": "string | null",
    "sourceType": "VERIFIED_OEM" | "VERIFIED_TECHNICAL" | "GENERAL_PRINCIPLE" | "MODEL_KNOWLEDGE" | "UNKNOWN",
    "vehicleSpecific": boolean
  }] | null,
  "safetyPreconditions": {
    "category": "SRS" | "HV" | "BRAKES" | "OTHER_CRITICAL" | null,
    "warnings": ["string"],
    "requiredSteps": ["string"],
    "needsVerifiedProcedure": boolean
  } | null,
  "hypotheses": [{
    "label": "string",
    "status": "LIKELY" | "POSSIBLE" | "WEAK" | "RULED_OUT",
    "confidence": number | null,
    "supportingEvidence": ["string"] | null,
    "contradictingEvidence": ["string"] | null,
    "note": "string | null"
  }] | null
}`;

/** Detect skipped / can't-perform / unavailable observation text. */
export function isSkippedOrUnavailableResult(resultText: string): boolean {
  const n = normalizeForCompare(resultText);
  if (!n) return false;
  return (
    n.includes("ne mogu izvesti") ||
    n.includes("preskocen") ||
    n.includes("preskoceno") ||
    n.includes("preskoci") ||
    /\bskipped\b/.test(n) ||
    n.includes("cant perform") ||
    n.includes("cannot perform") ||
    n.includes("can't perform") ||
    /\bunavailable\b/.test(n) ||
    n.includes("nije dostupan") ||
    n.includes("nije moguce izvesti") ||
    n.includes("test nedostupan")
  );
}

function latestHypothesesFromCase(
  diagnosticCase: DiagnosticCase,
): Hypothesis[] {
  for (let i = diagnosticCase.steps.length - 1; i >= 0; i -= 1) {
    const h = diagnosticCase.steps[i]?.hypotheses;
    if (h && h.length > 0) return h;
  }
  return [];
}

/** Explicit session case state sent on every model call. */
export function buildCaseState(diagnosticCase: DiagnosticCase) {
  const questionsAsked: string[] = [];
  const completedTests: Array<{ test: string; result: string }> = [];
  const skippedUnavailableTests: Array<{ test: string; reason: string }> = [];
  const answers: Array<{ question: string; answer: string }> = [];
  const measurements: string[] = [];
  const previousDiagnosticActions: Array<{
    actionType: string;
    content: string;
    outcome: "answered" | "result" | "skipped" | "pending";
  }> = [];
  const stepHistory: Array<{
    actionType: string;
    content: string;
    result: string | null;
    resultKind: "none" | "answer" | "measurement" | "skipped";
  }> = [];

  const extracted = refreshExtractedFacts(diagnosticCase);
  const knownFacts = buildKnownFactsSnapshot({
    ...diagnosticCase,
    extracted,
  });

  for (const step of diagnosticCase.steps) {
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    const result = obs?.resultText ?? null;
    const skipped = Boolean(result && isSkippedOrUnavailableResult(result));
    const stepLabel =
      step.actionType === "TEST"
        ? step.recommendedTest?.name?.trim() || step.content
        : step.content;

    let resultKind: "none" | "answer" | "measurement" | "skipped" = "none";
    if (result) {
      if (skipped) resultKind = "skipped";
      else if (step.actionType === "ASK") resultKind = "answer";
      else if (step.actionType === "TEST") resultKind = "measurement";
      else resultKind = "answer";
    }

    stepHistory.push({
      actionType: step.actionType,
      content: stepLabel,
      result,
      resultKind,
    });

    previousDiagnosticActions.push({
      actionType: step.actionType,
      content: stepLabel,
      outcome: !result
        ? "pending"
        : skipped
          ? "skipped"
          : step.actionType === "TEST"
            ? "result"
            : "answered",
    });

    if (step.actionType === "ASK") {
      questionsAsked.push(step.content);
      if (result && !skipped) {
        answers.push({ question: step.content, answer: result });
      }
    }

    if (step.actionType === "TEST") {
      if (result) {
        if (skipped) {
          skippedUnavailableTests.push({ test: stepLabel, reason: result });
        } else {
          completedTests.push({ test: stepLabel, result });
          measurements.push(result);
        }
      }
    }
  }

  const currentHypotheses = latestHypothesesFromCase(diagnosticCase).map(
    (h) => ({
      hypothesis: h.label,
      status: h.status,
      confidence: h.confidence ?? null,
      supportingEvidence: h.supportingEvidence ?? [],
      contradictingEvidence: h.contradictingEvidence ?? [],
      note: h.note ?? null,
    }),
  );

  const significantEvidenceCount = answers.length + completedTests.length;

  const measurementsMerged = [
    ...measurements,
    ...knownFacts.measurements.filter(
      (m) =>
        !measurements.some((x) => x.trim().toLowerCase() === m.trim().toLowerCase()),
    ),
  ];

  return {
    originalComplaint: diagnosticCase.problemText,
    // Top-level aliases kept for backend guards; prompt uses compactCaseStateForPrompt.
    vehicleInformation: knownFacts.vehicle,
    dtcs: knownFacts.knownDtcCodes,
    symptoms: knownFacts.symptoms,
    knownFacts,
    userObservations: diagnosticCase.observations
      .filter((o) => !isSkippedOrUnavailableResult(o.resultText))
      .map((o) => o.resultText),
    answersToPreviousQuestions: answers,
    questionsAlreadyAsked: questionsAsked,
    completedTests,
    skippedUnavailableTests,
    testResults: completedTests.map((t) => t.result),
    measurements: measurementsMerged,
    currentHypotheses,
    previousDiagnosticActions,
    diagnosticStepHistory: stepHistory,
    significantEvidenceCount,
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
    evidenceModel: {
      MEASURED_EVIDENCE:
        "Rezultati mehaničara (answers, completedTests, measurements) — stvarni dokazi.",
      REFERENCE_SPEC:
        "OEM/očekivani rasponi — dokaz SAMO ako status=VERIFIED u verifiedTechnicalSpecs. AI claim ≠ verified.",
      INDEPENDENT_CONFIRMATORY_EVIDENCE:
        "Dokazi iz različitih mjerenja/grana — ne broji isti signal više puta.",
    },
    instruction:
      "REEVALUATE all evidence. Use knownFacts — never re-ask known DTCs/vehicle facts already listed. FINISH uses diagnosisCertainty. CONFIRMED is rare. Respect rejectedDiagnoses.",
  };
}

/**
 * Prompt-only CASE STATE: drop redundant aliases of the same evidence.
 * Full buildCaseState remains for backend guards/verifier.
 */
export function compactCaseStateForPrompt(
  state: ReturnType<typeof buildCaseState>,
) {
  const kf = state.knownFacts;
  const historyResults = new Set(
    state.diagnosticStepHistory
      .map((s) => s.result?.trim().toLowerCase())
      .filter((r): r is string => Boolean(r)),
  );
  const historyContents = new Set(
    state.diagnosticStepHistory.map((s) => s.content.trim().toLowerCase()),
  );
  const complaintKey = state.originalComplaint.trim().toLowerCase();

  // Only intake extras not already present as step results.
  const extraMeasurements = kf.measurements.filter(
    (m) => !historyResults.has(m.trim().toLowerCase()),
  );
  const extraObservations = kf.observations.filter(
    (o) => !historyResults.has(o.trim().toLowerCase()),
  );
  // Symptoms that merely restate originalComplaint are redundant.
  const symptoms = kf.symptoms.filter(
    (s) => s.trim().toLowerCase() !== complaintKey,
  );
  // priorTests already mirrored in history content are redundant.
  const priorTests = kf.priorTests.filter(
    (t) => !historyContents.has(t.trim().toLowerCase()),
  );

  const knownFactsCompact: Record<string, unknown> = {};
  if (kf.vehicle) knownFactsCompact.vehicle = kf.vehicle;
  if (kf.knownDtcCodes.length) knownFactsCompact.knownDtcCodes = kf.knownDtcCodes;
  if (symptoms.length) knownFactsCompact.symptoms = symptoms;
  if (extraObservations.length) knownFactsCompact.observations = extraObservations;
  if (extraMeasurements.length) knownFactsCompact.measurements = extraMeasurements;
  if (priorTests.length) knownFactsCompact.priorTests = priorTests;

  // history already encodes Q/A + tests; omit null result / none kind noise.
  const history = state.diagnosticStepHistory.map((s) => {
    const row: Record<string, unknown> = {
      actionType: s.actionType,
      content: s.content,
    };
    if (s.result != null) row.result = s.result;
    if (s.resultKind !== "none") row.resultKind = s.resultKind;
    return row;
  });

  const out: Record<string, unknown> = {
    originalComplaint: state.originalComplaint,
    knownFacts: knownFactsCompact,
    history,
    significantEvidenceCount: state.significantEvidenceCount,
    status: state.status,
  };

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
        note: c.status === "VERIFIED" ? "LOCK" : "UNVERIFIED",
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

/** How many answered ASK steps form the trailing end of history. */
export function countTrailingAnsweredAsks(
  diagnosticCase: DiagnosticCase,
): number {
  let count = 0;
  for (let i = diagnosticCase.steps.length - 1; i >= 0; i -= 1) {
    const step = diagnosticCase.steps[i];
    if (!step || step.actionType !== "ASK") break;
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    if (!obs?.resultText?.trim()) break;
    if (isSkippedOrUnavailableResult(obs.resultText)) break;
    count += 1;
  }
  return count;
}

export function buildDiagnosticUserPrompt(diagnosticCase: DiagnosticCase): string {
  const caseState = buildCaseState(diagnosticCase);
  const compact = compactCaseStateForPrompt(caseState);
  const consecutiveAsks = caseState.consecutiveAnsweredAsksJustCompleted;
  const evidence = caseState.significantEvidenceCount;
  const rejected = caseState.rejectedDiagnoses as Array<{ diagnosis: string }>;
  const hasSkipped = caseState.skippedUnavailableTests.length > 0;

  // Situational nudges only — standing rules live in DIAGNOSTIC_SYSTEM_PROMPT.
  return [
    "CASE STATE (cijeli state; history=dokazi):",
    JSON.stringify(compact),
    "",
    "REEVALUATE → točno jedna ASK|TEST|FINISH → JSON.",
    evidence >= 2
      ? "≥2 dokaza: hypotheses max 3–4; preferiraj LIKELY/HIGH_CONFIDENCE nad lažnim CONFIRMED."
      : "Malo dokaza — diagnosisConfidence može biti null.",
    consecutiveAsks >= 1
      ? `${consecutiveAsks} ASK zaredom → preferiraj TEST/FINISH osim decision-critical grane.`
      : "",
    hasSkipped
      ? "resultKind=skipped ≠ dokaz — alternativni put, ne parafraza."
      : "",
    rejected.length > 0
      ? `Rejection (${rejected.length}): ne CONFIRMED bez novog neovisnog dokaza; ASK razlog ako nema; zatim diskriminirajući TEST.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildDiagnosticRetryPrompt(
  diagnosticCase: DiagnosticCase,
  previousDraft: unknown,
  issues: string[],
): string {
  return [
    buildDiagnosticUserPrompt(diagnosticCase),
    "",
    "Draft odbijen — vrati NOVI JSON (drugačiji od odbijenog).",
    "Problemi:",
    ...issues.map((issue) => `- ${issue}`),
    "",
    "Odbijeni draft:",
    JSON.stringify(previousDraft),
  ].join("\n");
}

export const VERIFIER_SYSTEM_PROMPT = `Ti si QUALITY / SAFETY / LOGIC gate za automotive dijagnostički draft.
NE vodiš dijagnostiku. NE biraš “bolju” dijagnozu/test. NE razgovaraš s mehaničarem. Samo odobri ili odbij draft.

approved=true samo ako draft prolazi SVE dolje. Inače approved=false.
Ako je reasoning tehnički upitan, nepotpun ili zahtijeva nagađanje → approved=false, correctedStep=null, 1–2 kratka issues. Diagnostic AI regenerira.
correctedStep SAMO za malu, očitu, sigurnu korekciju koja NE zahtijeva novi diagnostic reasoning (npr. skinuti izmišljeni broj, CONFIRMED→HIGH_CONFIDENCE uz insufficientEvidence, dopuniti očiti safety warning tekst). Nikad ne predlaži drugi TEST/ASK/FINISH path ni alternativnu dijagnozu.

Provjeri ISKLJUČIVO:

1) ONE ACTION — točno jedna ASK|TEST|FINISH; ASK=1 pitanje; TEST=1 test (≤2–3 podprovjere samo ako ista fizička radnja); bez liste planova/budućih koraka.

2) NO REPEAT — ne ponavlja poznato pitanje/test/mjerenje iz CASE STATE (uključujući semantički sličnu istu granu). Ne parafrazira skipped/unavailable test.

3) SKIPPED ≠ EVIDENCE — skipped/unavailable ne smije biti potvrda ni pobijanje hipoteze.

4) LOGIC / EVIDENCE — content+rationale+expectedResultHint+facts/evidence/hypotheses = jedan lanac.
   HARD FAIL (uvijek correctedStep=null):
   - interna kontradikcija ili kontradikcija ranijem koraku bez NOVOG dokaza
   - zaključak traži nedokazane premise / djelomične uvjete pretvara u puni zaključak
   - navedeni/CASE rezultat NE podržava zaključak
   - tvrdi kvar dijela bez dovoljno dokaza

5) SPEC — ne izmišlja vehicle-specific brojke/raspove/pinove koji nisu u verifiedTechnicalSpecs; AI claim ≠ VERIFIED; UNVERIFIED ≠ dokaz; ne mijenja locked claimedReferenceSpecs; sourceType obavezan; vehicle-specific ≠ GENERAL_PRINCIPLE; MODEL_KNOWLEDGE/UNKNOWN ≠ verified.

6) SAFETY — SRS/HV/kočnice/slično TEST mora imati safetyPreconditions (+ deaktivacija/odspajanje napajanja za SRS konektor/modul); ne izmišlja wait time → needsVerifiedProcedure.

7) FINISH / CONFIRMED — ne prerani FINISH; CONFIRMED samo uz jak neovisni potvrđujući dokaz (ne 1 simptom/DTC/neprovjerena spece/visok %); ne ignoriraj jake alternative; rejectedDiagnoses → ne CONFIRMED bez novog neovisnog dokaza; measured vs expected bez VERIFIED → ne CONFIRMED. Za FINISH očekuj diagnosisCertainty + diagnosisConfidence.

8) ASK — odbij ako info već poznata, ili različiti odgovori ne mijenjaju sljedeći korak, ili consecutiveAnsweredAsksJustCompleted≥1 bez jasnih grana.

9) TEST PRIORITY — odbij (correctedStep=null) ako je očito upstream/indirektan prvi korak (relej/osigurač/ECU/zvuk/vizual/“čest uzrok”) dok direktan mjerni test na granici sumnjive komponente (ulaz/napajanje/masa/signal) još nije napravljen i bio bi jednostavniji, sigurniji i bolje razdvaja hipoteze. Ne predlaži novu granu.

Odgovori ISKLJUČIVO JSON:
{
  "approved": boolean,
  "issues": ["string"],
  "correctedStep": null | {
    "actionType": "ASK" | "TEST" | "FINISH",
    "content": "string",
    "rationale": "string",
    "expectedResultHint": "string | null",
    "confirmedFault": "string | null",
    "confidence": "low" | "medium" | "high",
    "insufficientEvidence": boolean,
    "facts": ["string"] | null,
    "evidence": ["string"] | null,
    "technicalClaims": [{
      "claim": "string",
      "valueText": "string | null",
      "sourceType": "VERIFIED_OEM" | "VERIFIED_TECHNICAL" | "GENERAL_PRINCIPLE" | "MODEL_KNOWLEDGE" | "UNKNOWN",
      "vehicleSpecific": boolean
    }] | null,
    "safetyPreconditions": {
      "category": "SRS" | "HV" | "BRAKES" | "OTHER_CRITICAL" | null,
      "warnings": ["string"],
      "requiredSteps": ["string"],
      "needsVerifiedProcedure": boolean
    } | null,
    "hypotheses": [{
      "label": "string",
      "status": "LEADING" | "POSSIBLE" | "WEAK" | "RULED_OUT",
      "confidence": number | null,
      "supportingEvidence": ["string"] | null,
      "contradictingEvidence": ["string"] | null,
      "note": "string | null"
    }] | null
  }
}`;

export function buildVerifierUserPrompt(
  diagnosticCase: DiagnosticCase,
  draft: unknown,
  options?: {
    /** Prior primary-verifier / guard issues for strong-tier escalation. */
    previousIssues?: string[];
    /** Strong final verdict mode — no new diagnostic branch. */
    strongFinal?: boolean;
  },
): string {
  const caseState = buildCaseState(diagnosticCase);
  const compact = compactCaseStateForPrompt(caseState);
  const action = (draft as { actionType?: string })?.actionType;
  const notes: string[] = [];

  if (action === "ASK" && caseState.consecutiveAnsweredAsksJustCompleted >= 1) {
    notes.push("consecutive ASK ≥1 — odobri samo uz jasne različite grane.");
  }
  if (
    action === "TEST" &&
    caseState.skippedUnavailableTests.length > 0
  ) {
    notes.push("Postoje skipped (history resultKind=skipped) — odbij parafrazu.");
  }
  if ((caseState.rejectedDiagnoses as unknown[]).length > 0) {
    notes.push("rejectedDiagnoses aktivne — CONFIRMED samo uz novi neovisni dokaz.");
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

  return [
    "CASE STATE (compact; history=dokazi):",
    JSON.stringify(compact),
    "",
    "DRAFT:",
    JSON.stringify(draft),
    notes.length ? notes.join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Normalize text for cheap repetition checks. */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9čćžšđ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MEASUREMENT_FAMILIES: string[][] = [
  ["otpor", "ohm", "omski", "rezistan"],
  ["napon", "volt", "vdc", "signal"],
  ["kontinuitet", "prekid", "kratki spoj", "masa", "ground", "uzemljen"],
  ["struja", "amper", "miliamper"],
  ["tlak", "bar", "kpa"],
  ["temperatura", "temp"],
  ["skenir", "dtc", "kodove", "dijagnostick"],
  ["vizual", "pregled", "fizick", "stanje"],
];

const COMPONENT_HINTS = [
  "davac",
  "davač",
  "senzor",
  "plovak",
  "sender",
  "sensor",
  "konektor",
  "connector",
  "uticnica",
  "utikač",
  "instrument",
  "kazaljk",
  "pokazivac",
  "cluster",
  "osigurac",
  "relej",
  "ecu",
  "pcm",
  "modul",
  "rezervoar",
  "tank",
  "pumpa",
  "brizgalj",
  "svjecic",
  "kataliz",
  "turbo",
  "ventil",
  "aktuator",
  "snop",
  "vodic",
  "zica",
  "bus",
  "can",
  "lin",
  "abs",
  "klima",
  "kompresor",
  "mjenjac",
  "kvacilo",
  "ovjes",
  "lezaj",
];

function measurementFamiliesPresent(normalized: string): Set<number> {
  const found = new Set<number>();
  MEASUREMENT_FAMILIES.forEach((family, idx) => {
    if (family.some((token) => normalized.includes(token))) {
      found.add(idx);
    }
  });
  return found;
}

function componentHintsPresent(normalized: string): Set<string> {
  const found = new Set<string>();
  for (const hint of COMPONENT_HINTS) {
    const nh = normalizeForCompare(hint);
    if (nh && normalized.includes(nh)) found.add(nh);
  }
  return found;
}

function tokenOverlapRatio(a: string, b: string): { ratio: number; inter: number } {
  const ta = new Set(a.split(" ").filter((w) => w.length > 3));
  const tb = new Set(b.split(" ").filter((w) => w.length > 3));
  if (ta.size === 0 || tb.size === 0) return { ratio: 0, inter: 0 };
  let inter = 0;
  for (const w of ta) {
    if (tb.has(w)) inter += 1;
  }
  return { ratio: inter / Math.min(ta.size, tb.size), inter };
}

/**
 * Same diagnostic branch: shared measurement family + shared component hint,
 * or high lexical overlap on test instructions.
 */
export function testsAreSameDiagnosticBranch(
  candidate: string,
  previous: string,
): boolean {
  const a = normalizeForCompare(candidate);
  const b = normalizeForCompare(previous);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const famA = measurementFamiliesPresent(a);
  const famB = measurementFamiliesPresent(b);
  const bothHaveMeasurement = famA.size > 0 && famB.size > 0;
  let sharedFamily = false;
  for (const f of famA) {
    if (famB.has(f)) {
      sharedFamily = true;
      break;
    }
  }

  // Explicit different measurement types ⇒ different diagnostic branch.
  if (bothHaveMeasurement && !sharedFamily) return false;

  const meaningfulA = stripGenericTestTokens(a);
  const meaningfulB = stripGenericTestTokens(b);
  const { ratio, inter } = tokenOverlapRatio(meaningfulA, meaningfulB);
  if (ratio >= 0.6 && inter >= 3) return true;

  const compA = componentHintsPresent(a);
  const compB = componentHintsPresent(b);
  let sharedComponent = false;
  for (const c of compA) {
    if (compB.has(c)) {
      sharedComponent = true;
      break;
    }
  }

  if (sharedFamily && sharedComponent) return true;
  if (sharedFamily && ratio >= 0.4 && inter >= 2) return true;

  return false;
}

const GENERIC_TEST_TOKENS = new Set([
  "izmjeriti",
  "izmjeri",
  "mjerenje",
  "izmjer",
  "provjeriti",
  "provjeri",
  "provjera",
  "testirati",
  "test",
  "ocitati",
  "ocitaj",
  "vrijednost",
  "rezultat",
  "ponovno",
  "ponovo",
  "zatim",
  "paljenje",
  "vozilo",
]);

function stripGenericTestTokens(normalized: string): string {
  return normalized
    .split(" ")
    .filter((w) => w.length > 3 && !GENERIC_TEST_TOKENS.has(w))
    .join(" ");
}

/**
 * Detect obvious repeat of an already-asked question or completed test.
 * Conservative: only flags strong overlap, not soft similarity.
 */
export function findObviousRepetition(
  diagnosticCase: DiagnosticCase,
  draft: { actionType?: string; content?: string },
): string | null {
  const content = draft.content?.trim();
  if (!content || draft.actionType === "FINISH") return null;

  const normalizedNew = normalizeForCompare(content);
  if (normalizedNew.length < 12) return null;

  const state = buildCaseState(diagnosticCase);

  if (draft.actionType === "ASK") {
    for (const q of state.questionsAlreadyAsked) {
      const nq = normalizeForCompare(q);
      if (!nq) continue;
      if (normalizedNew === nq || containsAsCore(normalizedNew, nq)) {
        return `Ponavljanje već postavljenog pitanja: "${q.slice(0, 120)}"`;
      }
    }
    for (const a of state.answersToPreviousQuestions) {
      const nq = normalizeForCompare(a.question);
      if (nq && (normalizedNew === nq || containsAsCore(normalizedNew, nq))) {
        return `Pitanje već ima odgovor u CASE STATE: "${a.answer.slice(0, 80)}"`;
      }
    }
  }

  if (draft.actionType === "TEST") {
    for (const t of state.completedTests) {
      const nt = normalizeForCompare(t.test);
      if (!nt) continue;
      if (normalizedNew === nt || containsAsCore(normalizedNew, nt)) {
        return `Ponavljanje već završenog testa: "${t.test.slice(0, 120)}" (rezultat: ${t.result.slice(0, 80)})`;
      }
    }
  }

  return null;
}

/**
 * Reject TEST that is only a semantic twin of a completed or skipped test.
 */
export function findSimilarTestBranchIssue(
  diagnosticCase: DiagnosticCase,
  draft: { actionType?: string; content?: string; rationale?: string },
): string | null {
  if (draft.actionType !== "TEST") return null;
  const content = draft.content?.trim();
  if (!content) return null;

  const state = buildCaseState(diagnosticCase);

  for (const t of state.completedTests) {
    if (testsAreSameDiagnosticBranch(content, t.test)) {
      return (
        `Semantički sličan već završenom testu iste dijagnostičke grane: "${t.test.slice(0, 100)}" ` +
        `(rezultat: "${t.result.slice(0, 60)}"). Ne nastavljaj checklistu na istom dijelu/mjerenju. ` +
        "Odaberi test koji RAZLIKUJE preostale hipoteze drugim putem, ili FINISH ako je dokaz dovoljan."
      );
    }
  }

  for (const t of state.skippedUnavailableTests) {
    if (testsAreSameDiagnosticBranch(content, t.test)) {
      return (
        `Semantički sličan skipped/unavailable testu: "${t.test.slice(0, 100)}". ` +
        "To nije dokaz — nemoj preformulirati isti test. Predloži ALTERNATIVNI put do iste informacije " +
        "ili objasni da bez tog testa hipoteza nije pouzdano potvrdiva."
      );
    }
  }

  return null;
}

/**
 * Backend ASK gate: every ASK must prove decision value.
 * Rejects and forces TEST regeneration when:
 * - info already in case state (also covered by known-facts / repetition)
 * - missing why / expected answers / branch impact
 * - different answers lead to the same next step
 * - question only gathers context
 */
export function findAskDecisionGateIssue(
  diagnosticCase: DiagnosticCase,
  draft: {
    actionType?: string;
    content?: string;
    rationale?: string;
    askDecision?: {
      whyNeeded?: string | null;
      expectedAnswers?: string[] | null;
      nextStepByAnswer?: Array<{
        answer?: string;
        nextAction?: string;
      }> | null;
    } | null;
  },
): string | null {
  if (draft.actionType !== "ASK") return null;
  const state = buildCaseState(diagnosticCase);
  const normalizedQuestion = normalizeForCompare(
    `${draft.content ?? ""} ${draft.rationale ?? ""}`,
  );

  const askRejectPrefix =
    "ASK REJECT: neprikazuje se. Regeneriraj s actionType=TEST (najbolji sljedeći dijagnostički test). ";

  const dtcKnown = Array.isArray(state.dtcs) && state.dtcs.length > 0;
  const dtcDetailQuestion = isDtcDetailQuestion(normalizedQuestion);
  if (dtcKnown) {
    if (asksForDtcInventoryOrRescanLocal(normalizedQuestion)) {
      return (
        askRejectPrefix +
        `DTC je već poznat (${state.dtcs.join(", ")}). Ne traži ponovno DTC, prijeđi na relevantan TEST.`
      );
    }
    if (
      state.completedTests.length === 0 &&
      !dtcDetailQuestion &&
      asksGenericSymptomsOrWarningLight(normalizedQuestion)
    ) {
      return (
        askRejectPrefix +
        "Kod poznatog DTC-a ne pitaj opće simptome/lampice prije korištenja DTC traga. Odaberi TEST koji razlikuje uzroke tog DTC-a."
      );
    }
    if (!dtcDetailQuestion) {
      return (
        askRejectPrefix +
        "Poznat DTC je dovoljan za smislen prvi test. ASK je dopušten samo za nedostajući DTC detalj (status/opis/subcode) ako je potreban."
      );
    }
    if (hasKnownDtcDetailAlready(state, normalizedQuestion)) {
      return (
        askRejectPrefix +
        "Traženi DTC detalj je već u case stateu. Odaberi sljedeći TEST."
      );
    }
  }

  if (canSelectMeaningfulTestNow(state) && !dtcDetailQuestion) {
    return (
      askRejectPrefix +
      "Već postoji dovoljno podataka za smislen/siguran sljedeći TEST. ASK nije dopušten."
    );
  }

  const why =
    draft.askDecision?.whyNeeded?.trim() ||
    extractWhyFromRationale(draft.rationale ?? "");
  const expectedAnswers = (draft.askDecision?.expectedAnswers ?? [])
    .map((a) => a?.trim())
    .filter((a): a is string => Boolean(a));
  const branches = (draft.askDecision?.nextStepByAnswer ?? [])
    .map((b) => ({
      answer: b.answer?.trim() ?? "",
      nextAction: b.nextAction?.trim() ?? "",
    }))
    .filter((b) => b.answer && b.nextAction);

  // Structured path preferred
  if (draft.askDecision) {
    if (!why) {
      return (
        askRejectPrefix +
        "Nedostaje zašto je informacija potrebna (askDecision.whyNeeded)."
      );
    }
    if (isContextOnlyWhy(why)) {
      return (
        askRejectPrefix +
        "Pitanje samo prikuplja dodatni kontekst bez utjecaja na odluku."
      );
    }
    if (expectedAnswers.length < 2 && branches.length < 2) {
      return (
        askRejectPrefix +
        "ASK mora navesti najmanje 2 očekivana odgovora i kako svaki mijenja sljedeći korak."
      );
    }
    if (branches.length >= 2) {
      const norms = branches.map((b) => normalizeNextAction(b.nextAction));
      const allSame = norms.every((n) => n === norms[0]);
      if (allSame) {
        return (
          askRejectPrefix +
          "Različiti odgovori vode na ISTI sljedeći korak (candidateQuestionChangesNextAction===false). Odaberi taj TEST odmah."
        );
      }
    } else if (!rationaleHasDistinctBranches(draft.rationale ?? "")) {
      return (
        askRejectPrefix +
        "Nedostaje mapiranje odgovor → različiti sljedeći koraci (askDecision.nextStepByAnswer)."
      );
    }
  } else {
    // No structured askDecision — require explicit branch proof in rationale, else reject
    if (!why || isContextOnlyWhy(why) || !rationaleHasDistinctBranches(draft.rationale ?? "")) {
      return (
        askRejectPrefix +
        "Svaki ASK mora imati: (1) zašto je informacija potrebna, (2) očekivane odgovore, " +
        "(3) kako bi svaki odgovor promijenio sljedeći korak. Bez toga vrati TEST."
      );
    }
  }

  // Second consecutive ASK still needs clear branch justification
  const consecutive = countTrailingAnsweredAsks(diagnosticCase);
  if (consecutive >= 1 && !rationaleHasDistinctBranches(draft.rationale ?? "") && branches.length < 2) {
    return (
      askRejectPrefix +
      "Drugi uzastopni ASK bez jasnih različitih grana — vrati TEST."
    );
  }

  return null;
}

function extractWhyFromRationale(rationale: string): string {
  const t = rationale.trim();
  if (!t) return "";
  // First sentence often carries the "why"
  return t.split(/[.!\n]/)[0]?.trim() ?? t;
}

function isContextOnlyWhy(why: string): boolean {
  const n = normalizeForCompare(why);
  if (!n) return true;
  const contextOnly =
    /(potpunij|vise informac|dodatni kontekst|bolje razumij|opcenit|općenit|za svaki slucaj|za svaki slučaj|zanimljiv|korisno znati|nice to have)/.test(
      n,
    );
  const decisionSignal =
    /(razlik|odluc|odluč|grana|sljedeci|sljedeći|test|elimin|hipotez|ako\b)/.test(
      n,
    );
  return contextOnly && !decisionSignal;
}

function normalizeNextAction(text: string): string {
  return normalizeForCompare(text)
    .replace(/\b(onda|zatim|sljedeci|sljedeći|korak|test|ask|finish)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rationaleHasDistinctBranches(rationale: string): boolean {
  if (!rationaleHasBranchJustification(rationale)) return false;
  // Require at least two distinct action-ish phrases after ako/inače
  const r = rationale.toLowerCase();
  const parts = r.split(/\bako\b|ina[cč]e|u suprotnom|;/);
  const actions = parts
    .slice(1)
    .map((p) =>
      normalizeNextAction(
        p.replace(/^(ne\s+)?/, "").split(/[.!\n]/)[0] ?? "",
      ),
    )
    .filter((a) => a.length >= 8);
  if (actions.length < 2) return rationaleHasBranchJustification(rationale);
  return actions[0] !== actions[1];
}

function canSelectMeaningfulTestNow(state: ReturnType<typeof buildCaseState>): boolean {
  if ((state.dtcs?.length ?? 0) > 0) return true;
  if (state.completedTests.length > 0) return true;
  if ((state.measurements?.length ?? 0) > 0) return true;
  if (state.answersToPreviousQuestions.length >= 1 && (state.symptoms?.length ?? 0) > 0) {
    return true;
  }
  return false;
}

function asksForDtcInventoryOrRescanLocal(normalized: string): boolean {
  const asksInventory =
    /(ocitaj|ocitati|procitaj|skenir|scan|provjeri).{0,40}(dtc|kod|fault|gresk)/.test(
      normalized,
    ) ||
    /(ima li|postoji li|koji su|navedi|popis).{0,40}(dtc|kod|fault|gresk)/.test(
      normalized,
    ) ||
    /(dtc|kodovi|fault codes).{0,40}(ocitaj|ocitati|skenir|scan)/.test(
      normalized,
    );
  if (!asksInventory) return false;
  const asksDetailOnly =
    /(status|opis|znacenj|značenj|freeze|pending|confirmed|aktiv|povijest|frame|subcode).{0,40}(dtc|kod|df\d|[pcbu][0-9a-f]{4})/.test(
      normalized,
    ) || /(status|opis|subcode).{0,30}(df\d|[pcbu][0-9a-f]{4})/.test(normalized);
  return !asksDetailOnly;
}

function isDtcDetailQuestion(normalized: string): boolean {
  return (
    /(dtc|kod|gresk|fault|df\d|[pcbu][0-9a-f]{4})/.test(normalized) &&
    /(status|opis|znacenj|značenj|subcode|freeze|pending|confirmed|aktivan|memoriran|povijest|frame)/.test(
      normalized,
    )
  );
}

function hasKnownDtcDetailAlready(
  state: ReturnType<typeof buildCaseState>,
  normalizedQuestion: string,
): boolean {
  const wantsStatus = /(status|aktivan|memoriran|pending|confirmed|povijest)/.test(
    normalizedQuestion,
  );
  const wantsDescription = /(opis|znacenj|značenj|description)/.test(
    normalizedQuestion,
  );
  const wantsSubcode = /(subcode|podkod|freeze|frame)/.test(normalizedQuestion);
  if (!wantsStatus && !wantsDescription && !wantsSubcode) return false;

  const corpus = [
    ...state.answersToPreviousQuestions.map((a) => a.answer),
    ...state.userObservations,
    ...state.testResults,
  ]
    .map((x) => normalizeForCompare(x))
    .join(" | ");

  if (!corpus) return false;
  if (wantsStatus && /(aktivan|memoriran|pending|confirmed|povijest)/.test(corpus)) {
    return true;
  }
  if (wantsDescription && /(opis|znacenj|značenj|znaci|znači)/.test(corpus)) {
    return true;
  }
  if (wantsSubcode && /(subcode|podkod|freeze|frame)/.test(corpus)) {
    return true;
  }
  return false;
}

function asksGenericSymptomsOrWarningLight(normalized: string): boolean {
  return (
    /(simptom|kako se ponasa|kada se javlja|opcenito|općenito|opisi kvar)/.test(
      normalized,
    ) ||
    /(lampic|lampica|warning|mil|check engine|kontrolna)/.test(normalized)
  );
}

/**
 * After enough real evidence, reject pure checklist TESTs that don't claim to differentiate.
 */
export function findHypothesisDifferentiationIssue(
  diagnosticCase: DiagnosticCase,
  draft: { actionType?: string; content?: string; rationale?: string },
): string | null {
  if (draft.actionType !== "TEST") return null;

  const state = buildCaseState(diagnosticCase);
  if (state.significantEvidenceCount < 2) return null;
  if (state.completedTests.length < 1) return null;

  const rationale = normalizeForCompare(draft.rationale ?? "");
  const mentionsDifferentiate =
    /(razlik|hipotez|leading|vodec|alternativ|ako .+ (onda|→|->)|potvrd|elimin|iskljuc)/i.test(
      draft.rationale ?? "",
    ) ||
    rationale.includes("razlik") ||
    rationale.includes("hipotez");

  if (mentionsDifferentiate) return null;

  // Soft gate: only when we already have multiple completed tests
  if (state.completedTests.length < 2) return null;

  return (
    "Nakon više dokaza TEST mora u rationale jasno reći koje hipoteze razlikuje. " +
    "Ne predlaži još jedan test samo zato što nije napravljen. " +
    "Ako je LEADING dovoljno jak → FINISH; inače jedan potvrđujući test koji razdvaja alternative."
  );
}

/**
 * Prefer direct boundary measurement on the suspect component before upstream/indirect checks.
 * Generic — no component-specific hardcoding. Conservative: only obvious upstream/indirect-first.
 */
export function findTestPriorityIssue(
  diagnosticCase: DiagnosticCase,
  draft: { actionType?: string; content?: string; rationale?: string },
): string | null {
  if (draft.actionType !== "TEST") return null;
  const text = normalizeForCompare(
    `${draft.content ?? ""} ${draft.rationale ?? ""}`,
  );
  if (!text) return null;

  // Already measuring at component boundary → OK
  const isDirectBoundary =
    /(na (samoj )?komponent|na konektoru|na uticnici|na utikacu|granica komponent)/.test(
      text,
    ) ||
    (/(napajanj|masa|uzemljen|ground|b\+|ulaz|signal)/.test(text) &&
      /(izmjer|mjeren|napon|otpor|kontinuitet|provjer)/.test(text) &&
      /(na |konektor|komponent|uticnic|utikac)/.test(text));

  if (isDirectBoundary) return null;

  const isUpstreamFirst =
    /(relej|relay|osigurac|fuse|ecu naredb|pcm naredb|naredba (ecu|pcm|modula)|upravljacki (signal|dio|modul)|driver circuit|uzvodno|upstream|prije komponente)/.test(
      text,
    ) &&
    !/(na konektoru|napajanj.{0,24}(konektor|komponent)|masa.{0,24}(konektor|komponent)|signal.{0,24}(konektor|komponent))/.test(
      text,
    );

  const isWeakIndirect =
    /(poslusaj|slušaj|zvuk |culi |vizualn|pogledaj je li|izgleda kao|cest uzrok|tipican uzrok|obicno je)/.test(
      text,
    ) && !/(izmjer|mjeren|napon|otpor|tlak|kontinuitet|signal)/.test(text);

  if (!isUpstreamFirst && !isWeakIndirect) return null;

  const state = buildCaseState(diagnosticCase);
  const hasSuspectContext =
    state.currentHypotheses.length > 0 ||
    (state.dtcs?.length ?? 0) > 0 ||
    /(ne radi|ne pali|ne aktiv|neisprav|kvar|ne daje|nema |ne pali se|gubi )/.test(
      normalizeForCompare(state.originalComplaint),
    );
  if (!hasSuspectContext) return null;

  // After a direct boundary check already done, upstream follow-up is allowed.
  const alreadyDirect = state.completedTests.some((t) => {
    const n = normalizeForCompare(`${t.test} ${t.result}`);
    return (
      /(napajanj|masa|ground|uzemljen|signal|napon|otpor|kontinuitet)/.test(n) &&
      /(konektor|komponent|uticnic|utikac|na )/.test(n)
    );
  });
  if (alreadyDirect) return null;

  // Quick-check allowed only if rationale claims branch-changing speed tradeoff.
  if (isWeakIndirect) {
    const rationale = normalizeForCompare(draft.rationale ?? "");
    const claimsQuickBranch =
      /(brz|quick|trenutno|odmah).{0,40}(grana|sljedeci|mijenja|razlik)/.test(
        rationale,
      ) ||
      /(grana|sljedeci|razlik).{0,40}(brz|quick)/.test(rationale);
    if (claimsQuickBranch) return null;
  }

  return (
    "TEST PRIORITY REJECT: postoji očito jednostavniji, sigurniji i direktniji mjerni test na granici sumnjive komponente " +
    "(ulaz/napajanje/masa/signal) koji bolje razdvaja kvar komponente od napajanja/mase/upravljanja/instalacije. " +
    "Ne idi prvo na relej/osigurač/ECU/zvuk/vizual dok to nije provjereno. Regeneriraj DIREKTAN boundary TEST (bez izmišljenih pinova/napona)."
  );
}

/** Combined draft rejection reasons used before/after verifier. */
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
    askDecision?: {
      whyNeeded?: string | null;
      expectedAnswers?: string[] | null;
      nextStepByAnswer?: Array<{
        answer?: string;
        nextAction?: string;
      }> | null;
    } | null;
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
      supportingEvidence?: string[] | null;
      contradictingEvidence?: string[] | null;
    }> | null;
  },
): string | null {
  return (
    findReasoningConsistencyIssue(diagnosticCase, draft) ??
    findAlreadyKnownInfoIssue(diagnosticCase, draft) ??
    findAskDecisionGateIssue(diagnosticCase, draft) ??
    findSafetyAndTechnicalRuleIssue(diagnosticCase, draft) ??
    findSpecGuardIssue(diagnosticCase, draft) ??
    findConfirmationGuardIssue(diagnosticCase, draft) ??
    findObviousRepetition(diagnosticCase, draft) ??
    findSimilarTestBranchIssue(diagnosticCase, draft) ??
    findTestPriorityIssue(diagnosticCase, draft) ??
    findHypothesisDifferentiationIssue(diagnosticCase, draft)
  );
}

function rationaleHasBranchJustification(rationale: string): boolean {
  const r = rationale.toLowerCase();
  if (!r) return false;
  if (/(ako\s+.+\s*(→|->|onda)|ako\s+.+;\s*ako\s+)/i.test(rationale)) {
    return true;
  }
  const akoCount = (r.match(/\bako\b/g) ?? []).length;
  if (
    akoCount >= 2 &&
    /(test|izmjer|provjer|skenir|otpor|napon|signal)/i.test(r)
  ) {
    return true;
  }
  if (
    akoCount >= 1 &&
    /(inače|u suprotnom|ako ne|različiti?\s+test|drugačiji\s+test|grane?)/i.test(
      r,
    )
  ) {
    return true;
  }
  return false;
}

/** True if one string largely contains the other (shared core). */
function containsAsCore(a: string, b: string): boolean {
  if (a.length < 16 || b.length < 16) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const { ratio, inter } = tokenOverlapRatio(a, b);
  return ratio >= 0.75 && inter >= 4;
}
