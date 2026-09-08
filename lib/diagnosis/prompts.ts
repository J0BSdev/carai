import type { DiagnosticCase, Hypothesis } from "./types";
import {
  collectHistoricalReferenceClaims,
  findSpecGuardIssue,
  getVerifiedTechnicalSpecs,
} from "./spec-guard";
import { findConfirmationGuardIssue } from "./confirmation-guard";

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

=== PROBLEM: PONAVLJANJE ===
PRIJE ASK/TEST pročitaj CASE STATE (completedTests, skippedUnavailableTests, answers, measurements, currentHypotheses).
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
  "diagnosisCertainty": "SUSPECTED" | "LIKELY" | "HIGH_CONFIDENCE" | "CONFIRMED" | null,
  "diagnosisConfidence": "number | null — evidence ranking 0–100; null ako nema dovoljno dokaza",
  "confidence": "low" | "medium" | "high",
  "insufficientEvidence": "boolean — true za sve osim CONFIRMED",
  "facts": ["string"] | null,
  "evidence": ["string"] | null,
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
    vehicleInformation: diagnosticCase.extracted?.vehicle ?? null,
    dtcs: diagnosticCase.extracted?.dtcs ?? [],
    symptoms: diagnosticCase.extracted?.symptoms ?? [],
    userObservations: diagnosticCase.observations
      .filter((o) => !isSkippedOrUnavailableResult(o.resultText))
      .map((o) => o.resultText),
    answersToPreviousQuestions: answers,
    questionsAlreadyAsked: questionsAsked,
    completedTests,
    skippedUnavailableTests,
    testResults: completedTests.map((t) => t.result),
    measurements,
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
      "REEVALUATE all evidence. FINISH uses diagnosisCertainty (SUSPECTED|LIKELY|HIGH_CONFIDENCE|CONFIRMED). CONFIRMED is rare. Confidence != confirmation. Respect rejectedDiagnoses. Never invent vehicle-specific numeric specs.",
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

U tim slučajevima: approved=false; preferred correctedStep = bolji TEST drugim putem ILI FINISH.

skipped/unavailable NIJE dokaz — ne smije se tretirati kao potvrda/pobijanje.

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
Ako je draft loš i ne možeš ga pouzdano popraviti, approved=false, correctedStep=null, i navedi issues.`;

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
 * Programmatic ASK decision gate: after one answered ASK, a second consecutive ASK
 * is rejected unless rationale clearly justifies branching next tests.
 */
export function findAskDecisionGateIssue(
  diagnosticCase: DiagnosticCase,
  draft: { actionType?: string; content?: string; rationale?: string },
): string | null {
  if (draft.actionType !== "ASK") return null;

  const consecutive = countTrailingAnsweredAsks(diagnosticCase);
  if (consecutive < 1) return null;

  const rationale = draft.rationale?.trim() ?? "";
  if (rationaleHasBranchJustification(rationale)) return null;

  return (
    "Drugi uzastopni ASK bez dovoljne decision value: različiti odgovori moraju voditi u različite TEST-ove " +
    '(navedi u rationale npr. "ako A → test X; ako B → test Y"). Inače vrati TEST umjesto ASK. ' +
    "ASK only when decision-critical; if multiple answers lead to the same next test, skip the question."
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
  },
): string | null {
  return (
    findSpecGuardIssue(diagnosticCase, draft) ??
    findConfirmationGuardIssue(diagnosticCase, draft) ??
    findObviousRepetition(diagnosticCase, draft) ??
    findSimilarTestBranchIssue(diagnosticCase, draft) ??
    findAskDecisionGateIssue(diagnosticCase, draft) ??
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
