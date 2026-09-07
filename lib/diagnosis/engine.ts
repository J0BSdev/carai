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
      instruction:
        "Potvrdite podatke o vozilu (marka, model, godina, motor) i očitajte pohranjene DTC kodove dijagnostičkim uređajem.",
      rationale: `Uspostavite početnu sliku za: "${snippet}"`,
      expectedResultHint:
        "Navedite pronađene kodove ili zabilježite da kodova nema.",
    },
    {
      id: "step-2",
      instruction:
        "Napravite vizualni pregled povezanih sustava (kablovi, konektori, tekućine i očita mehanička oštećenja).",
      rationale: "Isključite jednostavne fizičke uzroke prije dubljih testova.",
      expectedResultHint: "Opišite što izgleda normalno, a što neuobičajeno.",
    },
    {
      id: "step-3",
      instruction:
        "Reproducirajte simptom u kontroliranim uvjetima i zabilježite kada se javlja (hladan/topao motor, prazan hod, opterećenje, brzina).",
      rationale: "Sužite način kvara prema radnim uvjetima.",
      expectedResultHint:
        "Navedite jeste li uspjeli reproducirati kvar i u kojim uvjetima.",
    },
    {
      id: "step-4",
      instruction:
        "Na temelju dosadašnjih nalaza provjerite najvjerojatniju komponentu ili krug multimetrom ili testom dimom/tlakom, ovisno o slučaju.",
      rationale: "Prijeđite s općih provjera na ciljanu verifikaciju.",
      expectedResultHint:
        "Zabilježite izmjerene vrijednosti ili prolaz/pad ciljanog testa.",
    },
  ];
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
      throw new Error("Za nastavak dijagnoze potreban je rezultat testa");
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
        message:
          "Mock dijagnostički motor: nema više koraka. Pregledajte opažanja i odlučite o popravku.",
      };
    }

    const nextStep = script[nextIndex];
    const updated: DiagnosticCase = {
      ...diagnosticCase,
      observations,
      steps: [...diagnosticCase.steps, nextStep],
      status: "active",
    };

    return {
      case: updated,
      nextStep,
      message: `Mock dijagnostički motor: napredak na ${nextStep.id}.`,
    };
  }
}

/**
 * Placeholder for a future LLM-backed engine.
 * Keep the same DiagnosticEngine interface so the API route can swap engines.
 */
export class LlmDiagnosticEngine implements DiagnosticEngine {
  async startCase(problemText: string): Promise<DiagnoseResponse> {
    void problemText;
    throw new Error(
      "LlmDiagnosticEngine još nije implementiran. Kasnije postavite AI_API_KEY i povežite providera.",
    );
  }

  async continueCase(
    diagnosticCase: DiagnosticCase,
    resultText: string,
  ): Promise<DiagnoseResponse> {
    void diagnosticCase;
    void resultText;
    throw new Error(
      "LlmDiagnosticEngine još nije implementiran. Kasnije postavite AI_API_KEY i povežite providera.",
    );
  }
}
