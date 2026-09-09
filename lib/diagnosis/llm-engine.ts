import {
  getClaudeApiKey,
  getDiagnosticModel,
  getOpenAiApiKey,
  getVerifierModel,
} from "./config";
import type { DiagnosticEngine } from "./engine";
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
import { mergeTechnicalSpecClaims } from "./spec-guard";
import { extractFactsFromText, refreshExtractedFacts } from "./known-facts";
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
  Hypothesis,
  Observation,
  RejectedDiagnosis,
} from "./types";

const ALLOWED_ACTIONS: AiActionType[] = ["ASK", "TEST", "FINISH"];

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
    // CONFIRMED is the only status that clears insufficientEvidence
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
  };
}

async function draftWithClaude(
  diagnosticCase: DiagnosticCase,
  userPrompt: string,
): Promise<LlmStepPayload> {
  const apiKey = getClaudeApiKey();
  if (!apiKey) {
    throw new Error("Nedostaje CLAUDE_API_KEY. Postavi ga u .env.");
  }

  const raw = await callAnthropicJson({
    apiKey,
    model: getDiagnosticModel(),
    system: DIAGNOSTIC_SYSTEM_PROMPT,
    user: userPrompt,
  });

  return parseJson<LlmStepPayload>(raw, "Claude dijagnostički odgovor");
}

async function verifyWithOpenAi(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): Promise<VerifierPayload> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("Nedostaje OPENAI_API_KEY. Postavi ga u .env.");
  }

  const raw = await callOpenAiJson({
    apiKey,
    model: getVerifierModel(),
    system: VERIFIER_SYSTEM_PROMPT,
    user: buildVerifierUserPrompt(diagnosticCase, draft),
  });

  const parsed = parseJson<VerifierPayload>(raw, "OpenAI verifier odgovor");
  return {
    approved: Boolean(parsed.approved),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    correctedStep: parsed.correctedStep ?? null,
  };
}

async function applyConfirmationPolicy(
  diagnosticCase: DiagnosticCase,
  draft: LlmStepPayload,
): Promise<LlmStepPayload> {
  if (draft.actionType !== "FINISH") return draft;
  const issue = findConfirmationGuardIssue(diagnosticCase, draft);
  if (!issue) {
    // Normalize certainty fields even when allowed
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
 * Dual-model pipeline:
 * 1) Claude (DIAGNOSTIC_MODEL) proposes the next ASK/TEST/FINISH step.
 * 2) Programmatic guard rejects repeats, similar-test branches, low-value ASKs.
 * 3) OpenAI (VERIFIER_MODEL) approves, corrects, or rejects.
 * 4) On reject without correction, Claude retries with verifier issues.
 */
async function callVerifiedDiagnosticStep(
  diagnosticCase: DiagnosticCase,
): Promise<DiagnosticStep> {
  const stepId = `step-${diagnosticCase.steps.length + 1}`;

  let draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticUserPrompt(diagnosticCase),
  );

  draft = await ensureDraftPassesQualityGates(diagnosticCase, draft);
  draft = await applyConfirmationPolicy(diagnosticCase, draft);

  let verdict = await verifyWithOpenAi(diagnosticCase, draft);

  if (!verdict.approved && verdict.correctedStep) {
    const correctedIssue = findDraftQualityIssue(
      diagnosticCase,
      verdict.correctedStep,
    );
    if (correctedIssue) {
      draft = await ensureDraftPassesQualityGates(
        diagnosticCase,
        verdict.correctedStep,
        [
          correctedIssue,
          "Predloži drugačiji korak bez ponavljanja iste dijagnostičke grane.",
        ],
      );
    } else {
      draft = verdict.correctedStep;
    }
  } else if (!verdict.approved) {
    draft = await draftWithClaude(
      diagnosticCase,
      buildDiagnosticRetryPrompt(
        diagnosticCase,
        draft,
        verdict.issues.length
          ? verdict.issues
          : ["Draft nije odobren; predloži ispravan jedan korak."],
      ),
    );
    draft = await ensureDraftPassesQualityGates(diagnosticCase, draft);
    verdict = await verifyWithOpenAi(diagnosticCase, draft);
    if (!verdict.approved && verdict.correctedStep) {
      const correctedIssue = findDraftQualityIssue(
        diagnosticCase,
        verdict.correctedStep,
      );
      if (correctedIssue) {
        draft = await ensureDraftPassesQualityGates(
          diagnosticCase,
          verdict.correctedStep,
          [correctedIssue],
        );
      } else {
        draft = verdict.correctedStep;
      }
    } else if (!verdict.approved) {
      throw new Error(
        `Verifier je odbio korak: ${verdict.issues.join("; ") || "nepoznat razlog"}`,
      );
    }
  }

  draft = await applyConfirmationPolicy(diagnosticCase, draft);
  return toDiagnosticStep(draft, stepId);
}

async function ensureDraftPassesQualityGates(
  diagnosticCase: DiagnosticCase,
  initialDraft: LlmStepPayload,
  extraIssues: string[] = [],
): Promise<LlmStepPayload> {
  let draft = initialDraft;

  if (draft.actionType === "FINISH") {
    const confIssue = findConfirmationGuardIssue(diagnosticCase, draft);
    if (confIssue) {
      draft = {
        ...downgradeUnjustifiedConfirmed(draft, confIssue),
        actionType: "FINISH",
      } as LlmStepPayload;
    }
  }

  let issue = findDraftQualityIssue(diagnosticCase, draft);
  if (!issue && extraIssues.length === 0) return draft;

  const askRejected =
    draft.actionType === "ASK" ||
    extraIssues.some((i) => /ASK REJECT/i.test(i)) ||
    (issue != null && /ASK REJECT/i.test(issue));

  const firstIssues = [
    ...(issue ? [issue] : []),
    ...extraIssues,
    "Predloži DRUGAČIJI sljedeći korak koristeći CASE STATE.",
    "Ne ponavljaj već postavljena pitanja ni završene/semantički slične testove.",
    askRejected
      ? "ASK je odbijen backend gateom. actionType MORA biti TEST — odmah odaberi najbolji sljedeći dijagnostički test. Ne vraćaj ASK."
      : "Ako ASK nema decision value → TEST. Ako TEST ne razlikuje hipoteze → bolji TEST ili FINISH.",
    "Skipped test nije dokaz — ne parafraziraj ga.",
  ];

  draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticRetryPrompt(diagnosticCase, draft, firstIssues),
  );

  // If model returned ASK again after rejection, force another TEST-only retry
  if (draft.actionType === "ASK") {
    const askIssue =
      findDraftQualityIssue(diagnosticCase, draft) ??
      "ASK REJECT: backend ne prikazuje ASK bez decision value — vrati TEST.";
    draft = await draftWithClaude(
      diagnosticCase,
      buildDiagnosticRetryPrompt(diagnosticCase, draft, [
        askIssue,
        "OBAVEZNO: actionType=TEST. Nemoj vraćati ASK. Odaberi najbolji diskriminirajući test iz CASE STATE.",
      ]),
    );
  }

  issue = findDraftQualityIssue(diagnosticCase, draft);
  if (!issue) return draft;

  draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticRetryPrompt(diagnosticCase, draft, [
      issue,
      "OBAVEZNO: vrati akciju iz DRUGE dijagnostičke grane ILI FINISH.",
      "Zabranjeno: isti dio + ista vrsta mjerenja kao completedTests/skippedUnavailableTests.",
      "Ako completedTests snažno podupiru LEADING hipotezu → FINISH, ali BEZ izmišljenih OEM brojki; bez verifiedTechnicalSpecs ne smiješ CONFIRMED usporedbom measured vs expected.",
      "Inače: jedan TEST koji razlikuje LEADING od najjače alternative (druga metoda/točka/sustav).",
      "U rationale navedi koje hipoteze razlikuješ.",
    ]),
  );
  issue = findDraftQualityIssue(diagnosticCase, draft);
  if (!issue) return draft;

  // Spec / FINISH recovery: no invented OEM numbers; LIKELY without verified comparison.
  draft = await draftWithClaude(
    diagnosticCase,
    buildDiagnosticRetryPrompt(diagnosticCase, draft, [
      issue,
      "ZADNJI POKUŠAJ ZA SPEC/FINISH PRAVILA:",
      "Ne navodi NITI JEDAN vehicle-specific brojčani OEM/referentni raspon (Ω/V/bar/…).",
      "Ako actionType=FINISH: insufficientEvidence=true, oznaci kao LIKELY / NEEDS CONFIRMATION.",
      "Usporedi samo MEASURED_EVIDENCE i kvalitativne principe — bez expectedSpecification brojki.",
      "Ili vrati TEST koji ne zahtijeva nepoznatu specifikaciju (npr. kontinuirana promjena signala).",
      "Reci eksplicitno ako referentni raspon nije verificiran.",
    ]),
  );

  issue = findDraftQualityIssue(diagnosticCase, draft);
  if (!issue) return draft;

  const isSpecIssue = /UNVERIFIED SPEC|FINISH GUARD|CONSISTENCY:/i.test(issue);

  if (draft.actionType !== "FINISH") {
    draft = {
      ...draft,
      actionType: "FINISH",
      content: isSpecIssue
        ? "LIKELY / NEEDS CONFIRMATION: na temelju prikupljenih mjerenja i opažanja vodi se sumnja na navedeni uzrok, ali točan OEM/referentni raspon za ovo vozilo nije verificiran pa se usporedba measured vs expected ne smije koristiti kao potvrda. Potrebna je potvrda metodom koja ne ovisi o neprovjerenoj specifikaciji ili unos verificiranog podatka."
        : draft.content?.trim() ||
          "Na temelju prikupljenih dokaza vodeća dijagnoza je najvjerojatniji uzrok; dodatni slični testovi ne bi dali novu informaciju.",
      rationale: isSpecIssue
        ? "FINISH GUARD: requiresExactSpec bez verifiedSpec — dijagnoza ostaje LIKELY, ne CONFIRMED."
        : draft.rationale?.trim() ||
          "Dodatni semantički slični testovi ne mijenjaju ranking hipoteza — završavam na temelju postojećih dokaza.",
      insufficientEvidence: true,
      confidence: "medium",
      confirmedFault: isSpecIssue
        ? draft.confirmedFault?.trim() ||
          "Vodeća sumnja prema mjerenjima (nije potvrđeno verificiranom specifikacijom)"
        : draft.confirmedFault ??
          "Vodeća hipoteza prema dostupnim dokazima (provjeri insufficientEvidence).",
    };
  }

  issue = findDraftQualityIssue(diagnosticCase, draft);
  if (issue) {
    if (draft.actionType === "FINISH") {
      return {
        ...draft,
        content:
          "LIKELY / NEEDS CONFIRMATION: dijagnoza se temelji na izmjerenim rezultatima i općim dijagnostičkim principima. Točan referentni raspon za ovo vozilo nije verificiran (specStatus=UNVERIFIED), stoga se ne potvrđuje usporedba measured vs expected OEM vrijednosti.",
        rationale:
          "Programski FINISH guard: odbijene neprovjerene/kontradiktorne specifikacije. UNVERIFIED SPEC nije dokaz.",
        insufficientEvidence: true,
        confidence: "medium",
        confirmedFault:
          "Vodeća sumnja (nije CONFIRMED — nedostaje verified specifikacija)",
        expectedResultHint: null,
      };
    }
    throw new Error(`AI draft odbijen: ${issue}. Pokušaj ponovno.`);
  }
  return draft;
}

function lightExtract(problemText: string): DiagnosticCase["extracted"] {
  return extractFactsFromText(problemText);
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
      extracted: lightExtract(trimmed),
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
      steps: [nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish ? nextStep.confirmedFault : undefined,
      technicalSpecClaims: mergeTechnicalSpecClaims(baseCase, draftText),
    };

    return {
      case: diagnosticCase,
      nextStep,
      message: `AI (${getDiagnosticModel()} + verifier ${getVerifierModel()}): ${nextStep.actionType}`,
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
      reopened.extracted = refreshExtractedFacts(reopened, trimmed);

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
      };

      return {
        case: updated,
        nextStep,
        message: `AI (${getDiagnosticModel()} + verifier ${getVerifierModel()}): ${nextStep.actionType} (reevaluate after ${isTechnicianRejection(trimmed) ? "rejection" : "continue"})`,
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
    caseWithObservation.extracted = refreshExtractedFacts(
      caseWithObservation,
      trimmed,
    );

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
    };

    return {
      case: updated,
      nextStep,
      message: `AI (${getDiagnosticModel()} + verifier ${getVerifierModel()}): ${nextStep.actionType}`,
    };
  }
}
