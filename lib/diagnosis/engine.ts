import type {
  DiagnosticCase,
  DiagnosticStep,
  DiagnoseResponse,
  Observation,
} from "./types";

export interface DiagnosticEngine {
  startCase(problemText: string): Promise<DiagnoseResponse>;
  continueCase(
    diagnosticCase: DiagnosticCase,
    resultText: string,
  ): Promise<DiagnoseResponse>;
}

function buildScriptedSteps(problemText: string): DiagnosticStep[] {
  const snippet =
    problemText.trim().length > 80
      ? `${problemText.trim().slice(0, 77)}...`
      : problemText.trim();

  return [
    {
      id: "step-1",
      actionType: "ASK",
      content:
        "Potvrdite marku, model, godinu, motor i približnu kilometražu. Jesu li svi simptomi i DTC kodovi koje ste naveli točni?",
      rationale: `Prije testova treba potvrditi osnovne činjenice za: "${snippet}"`,
      facts: ["Ulazni opis mehaničara zabilježen kao polazna evidencija."],
      hypotheses: [
        {
          label: "Uzrok još nije sužen",
          status: "plausible",
          note: "Nedovoljno potvrđenih podataka o vozilu.",
        },
      ],
      insufficientEvidence: true,
      confidence: "low",
      expectedResultHint:
        "Npr. VW Golf 7 GTD 2015, 2.0 TDI, ~180 tkm, P0299 potvrđen.",
    },
    {
      id: "step-2",
      actionType: "TEST",
      content:
        "Očitajte pohranjene i pending DTC kodove, te napravite brzi vizualni pregled usisa/turbo crijeva (očita oštećenja, stezaljke).",
      rationale:
        "DTC + očit usis razlikuju senzorske greške od grubih curenja prije dubljih mjerenja.",
      recommendedTest: {
        name: "Očitavanje DTC + vizualni pregled usisa",
        howTo:
          "Spojite dijagnostiku, zabilježite kodove. Provjerite crijeva i spojeve na usisu/turbinu.",
        whatToRecord: "Lista kodova + što ste vidjeli na usisu.",
      },
      hypotheses: [
        {
          label: "Curenje usisa / boost",
          status: "plausible",
        },
        {
          label: "Problem aktuatora / senzora boost-a",
          status: "plausible",
        },
      ],
      confidence: "medium",
      expectedResultHint: "Kodovi + nalaz vizualnog pregleda.",
    },
    {
      id: "step-3",
      actionType: "TEST",
      content:
        "Izvedite smoke test usisnog/boost sustava (ako već nije) ili izmjerite stvarni vs. traženi boost pri opterećenju iznad 3000 o/min.",
      rationale:
        "Ciljani test razdvaja curenje od problema kontrole turbine bez nagađanja skupih dijelova.",
      recommendedTest: {
        name: "Smoke test ili usporedba boost signala",
        howTo:
          "Smoke na usisu/boostu ILI log actual/requested boost pri vožnji/opterećenju.",
        whatToRecord:
          "Curenje da/ne (gdje) ILI kratki opis actual vs requested (bez izmišljenih brojki ako niste mjerili).",
        specs: {
          value: "Točne OEM granice nisu verificirane u mock motoru",
          verified: false,
        },
      },
      hypotheses: [
        {
          label: "Curenje boosta",
          status: "plausible",
        },
        {
          label: "Podboost zbog kontrole turbine",
          status: "plausible",
        },
      ],
      confidence: "medium",
      expectedResultHint: "Rezultat smoke testa ili boost usporedbe.",
    },
    {
      id: "step-4",
      actionType: "FINISH",
      content:
        "Na temelju mock petlje: pregledajte prikupljenu evidenciju i potvrdite najpodržaniji kvar prije zamjene dijelova. (Pravi LLM kasnije će dati konkretan confirmedFault.)",
      rationale:
        "Dovoljno koraka za demonstraciju petlje; mock ne izmišlja točne specifikacije ni skupu zamjenu bez dokaza.",
      confirmedFault:
        "Mock: uzrok još treba potvrditi stvarnim mjerenjem — nema dovoljno verificiranih dokaza za skupi dio.",
      confidence: "low",
      insufficientEvidence: true,
      facts: [
        "Mock engine ne tvrdi OEM napone, tlakove ni pinoute.",
      ],
    },
  ];
}

function applyLightExtraction(
  problemText: string,
): DiagnosticCase["extracted"] {
  const dtcMatches = problemText.toUpperCase().match(/P[0-9A-F]{4}/g);
  return {
    symptoms: [problemText.trim()],
    dtcs: dtcMatches ? [...new Set(dtcMatches)] : undefined,
    priorTests: undefined,
  };
}

export class MockDiagnosticEngine implements DiagnosticEngine {
  async startCase(problemText: string): Promise<DiagnoseResponse> {
    const trimmed = problemText.trim();
    if (!trimmed) {
      throw new Error("Za pokretanje dijagnoze potreban je opis kvara");
    }

    const script = buildScriptedSteps(trimmed);
    const firstStep = script[0];
    const diagnosticCase: DiagnosticCase = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      problemText: trimmed,
      extracted: applyLightExtraction(trimmed),
      observations: [],
      steps: [firstStep],
      status: "active",
    };

    return {
      case: diagnosticCase,
      nextStep: firstStep,
      message: "Mock dijagnostički motor: slučaj pokrenut.",
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

    if (diagnosticCase.status === "completed") {
      return {
        case: diagnosticCase,
        nextStep: null,
        message: "Slučaj je već završen.",
      };
    }

    const currentStep = diagnosticCase.steps[diagnosticCase.steps.length - 1];
    if (!currentStep) {
      throw new Error("Slučaj nema aktivni korak za zabilježiti");
    }

    // FINISH step should not require another answer; if somehow continued, complete.
    if (currentStep.actionType === "FINISH") {
      const completed: DiagnosticCase = {
        ...diagnosticCase,
        status: "completed",
        confirmedFault: currentStep.confirmedFault,
      };
      return {
        case: completed,
        nextStep: null,
        message: "Slučaj označen kao riješen (FINISH).",
      };
    }

    const observation: Observation = {
      stepId: currentStep.id,
      resultText: trimmed,
      recordedAt: new Date().toISOString(),
    };

    const observations = [...diagnosticCase.observations, observation];
    const script = buildScriptedSteps(diagnosticCase.problemText);
    const nextIndex = diagnosticCase.steps.length;

    if (nextIndex >= script.length) {
      const completed: DiagnosticCase = {
        ...diagnosticCase,
        observations,
        status: "completed",
      };

      return {
        case: completed,
        nextStep: null,
        message: "Mock dijagnostički motor: nema više koraka.",
      };
    }

    const nextStep = script[nextIndex];
    const isFinish = nextStep.actionType === "FINISH";

    const updated: DiagnosticCase = {
      ...diagnosticCase,
      observations,
      steps: [...diagnosticCase.steps, nextStep],
      status: isFinish ? "completed" : "active",
      confirmedFault: isFinish ? nextStep.confirmedFault : diagnosticCase.confirmedFault,
    };

    return {
      case: updated,
      // FINISH is returned so the UI can show the conclusion; case.status is already completed.
      nextStep,
      message: isFinish
        ? "Mock dijagnostički motor: FINISH."
        : `Mock dijagnostički motor: ${nextStep.actionType} (${nextStep.id}).`,
    };
  }
}

