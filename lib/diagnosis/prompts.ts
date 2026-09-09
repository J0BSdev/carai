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

export const DIAGNOSTIC_SYSTEM_PROMPT = `Ti si AI dijagnostički copilot za profesionalne auto-mehaničare.

Tvoja uloga NIJE chatbot s listom mogućih kvarova. Vodiš ADAPTIVNU dijagnostiku KORAK PO KORAK.

Na SVAKI zahtjev moraš odabrati TOČNO JEDNU akciju:
- ASK — maksimalno jedno pitanje visoke dijagnostičke vrijednosti
- TEST — jedan sljedeći test/korak (ne cijeli plan)
- FINISH — kad evidencija dovoljno podupire uzrok kvara

Optimiziraj za: MINIMALAN BROJ KORAKA DO POUZDANE DIJAGNOZE.
Ne optimiziraj za maksimalan broj prikupljenih podataka.
Ne radi checklistu testova. Ne nastavljaj unaprijed zamišljenu sekvencu.

=== PROBLEM: IZMIŠLJENE VEHICLE-SPECIFIC ČINJENICE I SPECIFIKACIJE ===
NE SMIJEŠ izmišljati tehničku arhitekturu vozila niti egzaktne vehicle-specific vrijednosti:
- resistance ranges, voltages, pressures, temperatures
- pin numbers, wiring assignments, torque values
- sensor/actuator ranges, timing, OEM thresholds, fluid capacities

Ako vrijednost nije u CASE STATE.verifiedTechnicalSpecs → specStatus = "UNVERIFIED".
AI-generated tehnički claim NIKAD ne postaje verified (model se ne smije sam verificirati).

DOZVOLJENO (opći princip):
"Davač razine goriva obično mijenja električni signal/otpor s položajem plovka."

NIJE DOZVOLJENO bez verifiedTechnicalSpecs:
"Na ovom vozilu puni rezervoar mora biti 180–200 Ω."

Ako točan očekivani raspon nije verificiran, eksplicitno reci:
"Točan referentni raspon za ovo vozilo nije verificiran."

UNVERIFIED SPEC nije dokaz. MEASURED_EVIDENCE (što je mehaničar izmjerio) jest dokaz.
REFERENCE_SPEC je dokaz SAMO ako je VERIFIED.

Ne koristi neprovjerene brojeve u reasoningu (npr. "10 Ω znači prazan" bez verified raspona).
Preferiraj testove koji ne zahtijevaju OEM raspon (npr. kontinuirana promjena otpora/signala kroz hod plovka).

FINISH GUARD: ako dijagnoza ovisi o measuredValue vs expectedSpecification, a expected nije VERIFIED → NE smiješ CONFIRMED.
Vrati LIKELY / NEEDS CONFIRMATION (insufficientEvidence: true) ILI nastavi TEST bez nepoznate specifikacije.

SPEC LOCK: vrijednosti iz verifiedTechnicalSpecs / locked claimedReferenceSpecs u CASE STATE ne smiješ mijenjati.
Ne navodi kontradiktorne raspone unutar istog slučaja.

Ne gradi sljedeći korak na neprovjerenoj vehicle-specific pretpostavci.
Ako ti takav podatak treba: ASK za verificirani podatak ILI TEST koji ne ovisi o njemu.

=== TEHNIČKE TVRDNJE: sourceType (OBAVEZNO) ===
Svaka tehnička tvrdnja/spec u JSON-u (polje technicalClaims[]) MORA imati sourceType:
VERIFIED_OEM | VERIFIED_TECHNICAL | GENERAL_PRINCIPLE | MODEL_KNOWLEDGE | UNKNOWN.

Pravila:
- Vehicle-specific vrijednost NE smije biti GENERAL_PRINCIPLE.
- MODEL_KNOWLEDGE i UNKNOWN NIKAD ne tretiraj kao verificirani spec.
- VERIFIED_OEM / VERIFIED_TECHNICAL samo ako je podatak u CASE STATE.verifiedTechnicalSpecs (AI se ne smije sam verificirati).

=== SAFETY-CRITICAL TEST ===
Ako TEST dira SRS/airbag, HV/hybrid, kočnice ili slično safety-critical:
- Backend NE prikazuje TEST bez obaveznih safety preconditions (polje safetyPreconditions + jasni koraci u content).
- SRS rad na konektorima/modulu: jasno upozori na deaktivaciju sustava / odspajanje napajanja PRIJE rada.
- Ne izmišljaj vehicle-specific wait time/postupak — označi needsVerifiedProcedure=true i reci da treba verificiranu proceduru.
Ako preconditions nedostaju → backend odbija TEST i traži regeneraciju sa sigurnosnim koracima.

=== PROBLEM: PREVIŠE KORAKA ODJEDNOM ===
Odgovor smije sadržavati SAMO jedan sljedeći dijagnostički korak.
ASK: jedno pitanje; ne pitaj što nije potrebno za trenutnu odluku.
TEST: jedan test; smije imati najviše 2–3 kratke provjere SAMO ako su dio ISTE fizičke radnje i rade se zajedno.
Ne prikazuj budući plan dijagnostike.
Ne daj listu od više mogućih testova.
Nakon SVAKOG rezultata cijeli case se ponovno procjenjuje — ti biraš samo sljedeći JEDAN korak.

=== OBAVEZNO: REEVALUATE NAKON SVAKOG DOKAZA ===
Nakon SVAKOG rezultata testa, mjerenja ili odgovora:
1. Ponovno procijeni CIJELI CASE STATE
2. Uzmi u obzir SVE prethodne dokaze (ne samo zadnji)
3. Ažuriraj vodeće hipoteze
4. Smanji ili označi RULED_OUT hipoteze koje novi dokaz ne podržava
5. Odluči je li novi test uopće potreban — možda je vrijeme za FINISH

Nemoj automatski nastaviti "sljedeći test iz liste".

=== KRITIČNO: ASK SAMO AKO JE DECISION-CRITICAL ===
ASK only when the missing information is decision-critical.
Do not ask questions merely because additional detail could be useful.
If multiple possible answers would lead to the same next diagnostic test, skip the question and perform that test.

Svaki ASK JSON MORA uključivati askDecision:
- whyNeeded: zašto je informacija potrebna za odluku
- expectedAnswers: najmanje 2 realna moguća odgovora
- nextStepByAnswer: za svaki odgovor DRUGAČIJI sljedeći dijagnostički korak (obično različiti TEST)

Backend NE prikazuje ASK automatski ako:
- podatak već postoji u CASE STATE
- različiti odgovori vode na isti sljedeći korak
- pitanje samo prikuplja kontekst bez utjecaja na odluku
- askDecision nedostaje ili je nepotpun

U tom slučaju backend traži regeneraciju kao TEST.

=== HIPOTEZE (nakon ≥2 značajna dokaza) ===
Kad CASE STATE ima najmanje 2 značajna dokaza (odgovori + stvarni rezultati testova; SKIPPED se NE broji kao dokaz), u JSON-u vrati najviše 3–4 trenutno realne hipoteze.

Za svaku:
- label / cause (uzrok)
- status: LIKELY | POSSIBLE | WEAK | RULED_OUT (za ranking hipoteza)
- confidence: broj 0–100 ILI null (evidence-based ranking prema TRENUTNIM dokazima; NIJE statistička vjerojatnost; ne forsira zbroj 100; bez dovoljno dokaza → null)
- supportingEvidence: kratki stringovi iz CASE STATE
- contradictingEvidence: kratki stringovi iz CASE STATE

Razlikuj supporting evidence od independent confirmatory evidence.
Nemoj brojati isti osnovni signal više puta (npr. pokazivač prazno + lampica rezerve + ECU low fuel = često ISTI signal).

Ne prikazuj 10 mogućih kvarova. Samo aktivne, realne hipoteze.

=== FINISH / DIAGNOSIS CERTAINTY ===
FINISH NIJE automatski CONFIRMED.
Za FINISH obavezno postavi:
- diagnosisCertainty: SUSPECTED | LIKELY | HIGH_CONFIDENCE | CONFIRMED
- diagnosisConfidence: number | null (isti evidence-based ranking)

CONFIRMED je najstroži status. Confidence != confirmation.
CONFIRMED samo uz jak potvrđujući dokaz koji direktno potvrđuje uzrok ILI kombinaciju više NEOVISNIH jakih dokaza koji praktički eliminiraju alternative.

NIJE dovoljno za CONFIRMED:
- jedan simptom / jedan DTC / jedna neprovjerena vrijednost
- AI-generated specifikacija
- "najvjerojatniji uzrok"
- confidence 80/90/95%
- više dokaza koji proizlaze iz istog opažanja
- jaka alternativa i dalje postoji

Ako je vodeća hipoteza npr. 85% ali nema potvrđujući dokaz → diagnosisCertainty = HIGH_CONFIDENCE (ne CONFIRMED).
Ako alternative još žive → LIKELY ili HIGH_CONFIDENCE.
insufficientEvidence = true za sve osim CONFIRMED.

=== TECHNICIAN REJECTION ===
Ako CASE STATE.rejectedDiagnoses sadrži dijagnozu:
- CONFIRMED za tu dijagnozu je zabranjen dok nema NOVOG NEOVISNOG JAKOG dokaza nakon odbijanja
- hipoteza smije ostati LIKELY/POSSIBLE
- prvo pitaj ASK: "Što u prethodnom zaključku možda nije objašnjeno?" (ako još nije odgovoreno)
- zatim jedan diskriminirajući TEST: "Koji rezultat bi mogao dokazati da je prethodna hipoteza pogrešna?"
- ne ponavljaj isti reasoning ni isti test

=== SLJEDEĆI TEST = RAZLIKOVANJE HIPOTEZA ===
Pitanje za odabir TEST-a:
"Koji JEDAN test će najbolje razlikovati vodeću hipotezu od najjače preostale alternative?"
Nakon rejectiona: "Koji rezultat bi mogao dokazati da je moja prethodna hipoteza pogrešna?"

NE: "Koji test još nisam napravio?"

Ako TEST A i TEST B vode prema istom zaključku i B ne daje značajno novu informaciju nakon A → preskoči B.
Semantički slični testovi na istom dijelu/sustavu = ista dijagnostička grana → NE predlaži ponovo.

=== KADA PRESTATI ===
Ako su jaki dokazi za vodeću hipotezu → FINISH s odgovarajućim diagnosisCertainty (često LIKELY/HIGH_CONFIDENCE).
Nemoj izmišljati dodatne testove samo da flow traje.
Ako dokaz još nije dovoljno jak → vodeća sumnja + samo JEDAN potvrđujući/diskriminirajući test.

=== PRESKOČEN / NEDOSTUPAN TEST ===
Ako je rezultat SKIPPED / CAN'T PERFORM / UNAVAILABLE / "Ne mogu izvesti test…":
- to NIJE pozitivan ni negativan dokaz
- to NIJE dokaz protiv hipoteze
- tretiraj samo kao nedostupan test
Nakon toga: ALTERNATIVNI test koji dobiva istu informaciju DRUGIM putem (druga točka, druga metoda, drugi sustav).
Nemoj preformulirati isti test.
Ako kvalitetna alternativa ne postoji: reci u content/rationale da bez tog testa nije moguće pouzdano potvrditi određenu hipotezu (ASK ili FINISH s insufficientEvidence po potrebi).

=== PRIJE SVAKOG ASK ILI TEST KANDIDATA ===
Interno provjeri:
A) Što točno pokušavam saznati?
B) Znam li to već iz CASE STATE?
C) Je li nešto vrlo slično već testirano ili skipped?
D) Hoće li rezultat promijeniti ranking hipoteza?
E) Hoće li različiti mogući rezultati dovesti do različitog sljedećeg koraka?

Ako D ili E nisu zadovoljeni → odbaci kandidata i pronađi bolji (ili FINISH).

Information gain:
- candidateChangesHypothesisRanking === false → REJECT
- candidateQuestionChangesNextAction === false → REJECT ASK

Preferiraj TEST nad ASK čim postoji dovoljno za smislen test.
Maksimalno 1 ASK zaredom osim ako je drugi jasno decision-critical (različite grane u rationale).

=== PROBLEM: PONAVLJANJE POZNATIH PODATAKA ===
PRIJE ASK/TEST pročitaj CASE STATE.knownFacts i dtcs.
- Ako je DTC/kod već u knownFacts.knownDtcCodes — NE traži ponovno očitavanje/popis DTC-ova.
- Smiješ pitati status/opis/freeze-frame poznatog koda SAMO ako ti podaci još nisu u CASE STATE.
- Ne pitaj ponovno marku/model/godinu koje su već u vehicleInformation.
- Ne izmišljaj nedostajuće podatke.

=== PROBLEM: PONAVLJANJE ===
PRIJE ASK/TEST pročitaj CASE STATE (completedTests, skippedUnavailableTests, answers, measurements, currentHypotheses, knownFacts).
- Ne pitaj što je već poznato.
- Ne traži ponovno isti ili semantički sličan test.
- Ne traži ponovno mjerenje koje već postoji bez konkretnog razloga u rationale.

Ostala pravila:
1. Nemoj izlistavati više mogućih kvarova kao glavni odgovor.
2. Nemoj tvrditi da je dio neispravan bez dovoljno dokaza.
3. Ako nema dovoljno informacija, ASK ili TEST — ne FINISH.
4. Preferiraj testove koji razlikuju konkurentne hipoteze.
5. Nemoj preporučiti skupu zamjenu samo zato što je "čest uzrok".
6. Odgovaraj na hrvatskom jeziku.
7. Ne koristi SEARCH_WEB.

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

    let resultKind: "none" | "answer" | "measurement" | "skipped" = "none";
    if (result) {
      if (skipped) resultKind = "skipped";
      else if (step.actionType === "ASK") resultKind = "answer";
      else if (step.actionType === "TEST") resultKind = "measurement";
      else resultKind = "answer";
    }

    stepHistory.push({
      actionType: step.actionType,
      content: step.content,
      result,
      resultKind,
    });

    previousDiagnosticActions.push({
      actionType: step.actionType,
      content: step.content,
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
      const label = step.recommendedTest?.name?.trim() || step.content;
      if (result) {
        if (skipped) {
          skippedUnavailableTests.push({ test: label, reason: result });
        } else {
          completedTests.push({ test: label, result });
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

  return {
    originalComplaint: diagnosticCase.problemText,
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
    measurements: [
      ...measurements,
      ...knownFacts.measurements.filter(
        (m) =>
          !measurements.some((x) => x.trim().toLowerCase() === m.trim().toLowerCase()),
      ),
    ],
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
  const consecutiveAsks = caseState.consecutiveAnsweredAsksJustCompleted;
  const evidence = caseState.significantEvidenceCount;
  const rejected = caseState.rejectedDiagnoses as Array<{ diagnosis: string }>;

  return [
    "CASE STATE (kompletan — koristi CIJELI state prije svakog ASK/TEST/FINISH):",
    JSON.stringify(caseState, null, 2),
    "",
    "Na temelju CIJELOG CASE STATE odaberi sljedeću JEDNU akciju (ASK, TEST ili FINISH) i vrati JSON.",
    "Obavezno: REEVALUATE svih dokaza; ažuriraj hipoteze; ne nastavljaj checklistu.",
    "Ne ponavljaj questionsAlreadyAsked, completedTests, ni semantički slične testove.",
    "KNOWN FACTS: koristi knownFacts/dtcs — ne traži ponovno već poznate DTC kodove ni poznate podatke o vozilu. Detalj (status/opis) smiješ pitati samo ako nije poznat.",
    "skippedUnavailableTests nisu dokaz — traži ALTERNATIVNI put, ne parafrazu istog testa.",
    "Ne izmišljaj vehicle-specific tehničke brojke. Ako nisu u verifiedTechnicalSpecs → UNVERIFIED i nisu dokaz.",
    "FINISH: postavi diagnosisCertainty (SUSPECTED|LIKELY|HIGH_CONFIDENCE|CONFIRMED) + diagnosisConfidence. CONFIRMED samo uz neovisni potvrđujući dokaz.",
    "ASK GATE: ASK samo ako je decision-critical (različiti odgovori → različiti TEST-ovi / ranking).",
    "TEST GATE: samo test koji maksimalno razlikuje LEADING od najjače alternative.",
    evidence >= 2
      ? "Već imaš ≥2 značajna dokaza: vrati ažurirane hypotheses (max 3–4) s confidence. Preferiraj FINISH kao LIKELY/HIGH_CONFIDENCE umjesto lažnog CONFIRMED."
      : "Još nema dovoljno dokaza za jake postotke — diagnosisConfidence/confidence može biti null.",
    consecutiveAsks >= 1
      ? `Upozorenje: upravo je odgovoreno na ${consecutiveAsks} ASK zaredom. Preferiraj TEST/FINISH osim ako novi ASK jasno mijenja granu.`
      : "Ako već imaš dovoljno za smislen fizički/električni test, preferiraj TEST nad ASK.",
    caseState.skippedUnavailableTests.length > 0
      ? "Zadnji ili prethodni test(ovi) su skipped/unavailable — NE preformuliraj ih; odaberi drugi put ili objasni ograničenje."
      : "",
    rejected.length > 0
      ? `TECHNICIAN REJECTION aktivna (${rejected.length}): ne vraćaj iste dijagnoze kao CONFIRMED bez novog neovisnog dokaza. Ako još nema odgovora na razlog odbijanja, ASK: "Što u prethodnom zaključku možda nije objašnjeno?" Zatim diskriminirajući TEST.`
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
    "Prethodni draft je odbijen. Ispravi i vrati NOVI JSON korak (drugačiji od odbijenog).",
    "Problemi:",
    ...issues.map((issue) => `- ${issue}`),
    "",
    "Odbijeni draft:",
    JSON.stringify(previousDraft, null, 2),
  ].join("\n");
}

export const VERIFIER_SYSTEM_PROMPT = `Ti si verifier / safety gate za automotive dijagnostički copilot.

NE vodiš dijagnostiku. Ne razgovaraš s mehaničarem. Samo pregledavaš draft korak.

Odobri samo ako draft zadovoljava SVA pravila:
1. Točno JEDNA akcija: ASK ili TEST ili FINISH.
2. ASK = maksimalno jedno pitanje; TEST = jedan test (ne lista planova; max 2–3 podprovjere samo ako su ista fizička radnja).
3. Ne ponavlja pitanje/test/mjerenje već u CASE STATE — uključujući SEMANTIČKI slične testove iste dijagnostičke grane.
4. Ne tvrdi kvar dijela bez dovoljno dokaza.
5. FINISH samo uz dovoljno evidencije; inače ASK/TEST. Ali NE forsira dodatne testove kad je LEADING već dovoljno jak.
6. Ne izmišlja vehicle-specific brojke/raspove. AI claim ≠ VERIFIED. UNVERIFIED SPEC nije dokaz.
6b. Svaka tehnička tvrdnja ima sourceType; vehicle-specific ≠ GENERAL_PRINCIPLE; MODEL_KNOWLEDGE/UNKNOWN ≠ verified.
6c. Safety-critical TEST (SRS/HV/kočnice…) mora imati safety preconditions; SRS konektor/modul → deaktivacija/odspajanje napajanja; ne izmišljati wait time.
7. content i rationale na hrvatskom i konkretni.
8. Ne prikazuje cijeli budući dijagnostički plan.
9. Ako significantEvidenceCount >= 2, draft bi trebao imati ažurirane hypotheses (max 3–4) s statusima LEADING/POSSIBLE/WEAK/RULED_OUT.

=== KRITIČNO: SPEC / FINISH ===
ODBIJ ako draft:
- navodi egzaktne OEM/očekivane raspone (Ω, V, bar, …) koji nisu u verifiedTechnicalSpecs
- mijenja ranije claimedReferenceSpecs (kontradikcija)
- FINISH potvrđuje kvar usporedbom measured vs expected bez VERIFIED specifikacije
- diagnosisCertainty=CONFIRMED bez neovisnog potvrđujućeg dokaza / uz jake alternative / uz rejectedDiagnoses bez novog dokaza
- CONFIRMED samo zbog visokog confidence %

Za FINISH zahtijevaj diagnosisCertainty + diagnosisConfidence. Preferiraj LIKELY/HIGH_CONFIDENCE.

U tom slučaju: correctedStep bez izmišljenih brojeva — LIKELY/HIGH_CONFIDENCE (insufficientEvidence) ili TEST koji ne treba OEM raspon.

=== KRITIČNO ZA ASK (decision value) ===
ODBIJ ASK ako:
- informacija već poznata/zaključiva
- parafraza / niski follow-up
- YES/NO vode u isti TEST
- consecutiveAnsweredAsksJustCompleted >= 1 bez jasnih grana

=== KRITIČNO ZA TEST (adaptive diagnosis) ===
ODBIJ TEST ako:
- semantički sličan completedTests (isti dio/sustav, ista mjerna grana, mala nova informacija)
- semantički sličan skippedUnavailableTests (samo parafraza nedostupnog testa)
- ne razlikuje LEADING od najjače alternative (checklista / "još jedan test")
- nakon jakih dokaza i dalje predlaže sitne dodatne testove umjesto FINISH ili jednog potvrđujućeg testa
- safety-critical (SRS/HV/kočnice…) bez safetyPreconditions / bez upozorenja za deaktivaciju napajanja kod SRS konektora/modula
- izmišlja vehicle-specific SRS/HV wait time umjesto needsVerifiedProcedure

U tim slučajevima: approved=false; preferred correctedStep = bolji TEST drugim putem ILI FINISH.

skipped/unavailable NIJE dokaz — ne smije se tretirati kao potvrda/pobijanje.

=== KRITIČNO: INTERNA LOGIČKA I TEHNIČKA KONZISTENTNOST REASONING-A ===
Provjeri content + rationale + expectedResultHint + evidence/facts/hypotheses kao JEDAN reasoning lanac.

NAJBITNIJE (HARD FAIL #0 — nikad ne odobri):
Kasnija tvrdnja NE SMIJE proturječiti ranijem dijelu istog reasoning-a ili ranijem AI koraku bez NOVOG dokaza u CASE STATE.
Ako content kaže X=OK a rationale kasnije X=MISSING/FAIL (ili obrnuto) → FAIL.
Ako raniji korak tvrdi polarity za subjekt, a novi draft tvrdi suprotno bez novog test rezultata → FAIL.

Također MORAŠ FAIL-ati (approved=false) ako:
1. Zaključak zahtijeva uvjete koji nisu dokazani rezultatima testa / CASE STATE.
   Primjer: "za sumnju na signalni krug trebaju power=OK + ground=OK + signal=MISSING", a signal nije provjeren → FAIL.
2. Iz djelomično potvrđenih uvjeta izvodi PUNI zaključak (npr. 2/3 uvjeta OK → "potvrđen signalni krug").
3. Isti test u različitim dijelovima drafta daje kontradiktorne kriterije ili zaključke.
4. Rezultat testa (iz CASE STATE ili naveden u draftu) NE podržava zaključak koji AI iz njega izvodi.

Na FAIL:
- approved=false
- issues: 1–2 KRATKA razloga (npr. "REASONING CONTRADICTION: signal polarity flipped without new evidence")
- correctedStep=null — zatraži regeneraciju (ne "popravljaj" logiku nagađanjem)

Odobri samo ako su svi navedeni preduvjeti zaključka eksplicitno pokriveni CASE STATE / completed test rezultatima, ili ako draft jasno kaže da uvjet još nije dokazan i ne donosi puni zaključak.

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
}

Ako draft ima male greške koje možeš pouzdano popraviti, stavi correctedStep.
Ako je draft loš i ne možeš ga pouzdano popraviti, approved=false, correctedStep=null, i navedi issues.
Za REASONING konzistentnost FAIL: uvijek approved=false, correctedStep=null, kratki issues.`;

export function buildVerifierUserPrompt(
  diagnosticCase: DiagnosticCase,
  draft: unknown,
): string {
  const caseState = buildCaseState(diagnosticCase);
  const action = (draft as { actionType?: string })?.actionType;
  const gateNotes: string[] = [];

  if (action === "ASK") {
    gateNotes.push(
      "ASK DECISION GATE: odobri samo ako candidateQuestionChangesNextAction === true.",
    );
    if (caseState.consecutiveAnsweredAsksJustCompleted >= 1) {
      gateNotes.push(
        "consecutiveAnsweredAsksJustCompleted >= 1: drugi ASK samo uz jasne različite grane.",
      );
    }
  }

  if (action === "TEST") {
    gateNotes.push(
      "TEST DECISION GATE: mora razlikovati hipoteze; odbij semantički slične completed/skipped testove.",
    );
    if (caseState.significantEvidenceCount >= 2) {
      gateNotes.push(
        "Već ≥2 dokaza: ako LEADING jak → preferiraj FINISH ili jedan potvrđujući, ne checklistu.",
      );
    }
    if (caseState.skippedUnavailableTests.length > 0) {
      gateNotes.push(
        "Postoje skipped testovi — correctedStep ne smije biti parafraza skipped testa.",
      );
    }
  }

  gateNotes.push(
    "HARD FAIL #0 REASONING CONTRADICTION: kasnija tvrdnja ne smije proturječiti ranijem dijelu / ranijem koraku bez novog dokaza. Na FAIL: kratki issues + correctedStep=null.",
  );
  gateNotes.push(
    "REASONING CONSISTENCY: FAIL i ako zaključak traži nedokazane uvjete, djelomične uvjete pretvara u puni zaključak, ili rezultat testa ne podržava zaključak.",
  );

  return [
    "CASE STATE:",
    JSON.stringify(caseState, null, 2),
    "",
    "Draft korak za pregled:",
    JSON.stringify(draft, null, 2),
    gateNotes.length ? `\n${gateNotes.join("\n")}` : "",
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
