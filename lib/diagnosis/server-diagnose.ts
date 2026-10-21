import type { UsageAccess } from "@/lib/access";
import {
  commitCaseUpdate,
  insertStartedCase,
  isTurnLocked,
  loadOwnedCase,
  releaseTurnLock,
  tryAcquireTurnLock,
} from "@/lib/cases/server-case-store";
import {
  InvalidObservationError,
  ObservationConflictError,
} from "@/lib/diagnosis/errors";
import { LlmDiagnosticEngine } from "@/lib/diagnosis/llm-engine";
import {
  sameObservation,
  stampObservation,
} from "@/lib/diagnosis/observation";
import type {
  DiagnoseResponse,
  DiagnosticCase,
  Observation,
  ObservationInput,
  TurnImage,
} from "@/lib/diagnosis/types";

const engine = new LlmDiagnosticEngine();

export class CasePersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasePersistError";
  }
}

export class CaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseConflictError";
  }
}

export class CaseNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseNotFoundError";
  }
}

function userIdOf(access: UsageAccess & { ok: true }): string | null {
  return access.user?.id ?? null;
}

function observationForCompare(
  stepId: string,
  observation: ObservationInput,
  image?: TurnImage,
): Observation {
  const recorded: ObservationInput =
    observation.kind === "RESULT"
      ? {
          kind: "RESULT",
          ...(observation.text ? { text: observation.text } : {}),
          ...(image ? { hasPhoto: true } : {}),
        }
      : observation;
  return stampObservation(stepId, recorded);
}

function stepIndex(diagnosticCase: DiagnosticCase, stepId: string): number {
  return diagnosticCase.steps.findIndex((step) => step.id === stepId);
}

function turnAlreadyCompleted(
  diagnosticCase: DiagnosticCase,
  stepId: string,
): boolean {
  const index = stepIndex(diagnosticCase, stepId);
  if (index < 0) return false;
  const hasObs = diagnosticCase.observations.some((o) => o.stepId === stepId);
  return hasObs && diagnosticCase.steps.length > index + 1;
}

function responseFromCase(
  diagnosticCase: DiagnosticCase,
  caseVersion: number,
): DiagnoseResponse {
  const last = diagnosticCase.steps[diagnosticCase.steps.length - 1] ?? null;
  return { case: diagnosticCase, nextStep: last, caseVersion };
}

async function persistOrThrow(
  diagnosticCase: DiagnosticCase,
  expectedVersion: number,
  lockToken: string,
  userId: string | null,
): Promise<number> {
  try {
    const next = await commitCaseUpdate(
      diagnosticCase,
      expectedVersion,
      lockToken,
      userId,
    );
    if (next == null) {
      throw new CaseConflictError(
        "Slučaj je u međuvremenu promijenjen. Osvježi i pokušaj ponovno.",
      );
    }
    return next;
  } catch (error) {
    if (error instanceof CaseConflictError) throw error;
    throw new CasePersistError(
      error instanceof Error ? error.message : "Spremanje slučaja nije uspjelo.",
    );
  }
}

export async function diagnoseStart(
  problemText: string,
  image: TurnImage | undefined,
  access: UsageAccess & { ok: true },
): Promise<DiagnoseResponse> {
  const result = await engine.startCase(problemText, image);
  try {
    const caseVersion = await insertStartedCase(
      result.case,
      userIdOf(access),
    );
    return { ...result, caseVersion };
  } catch (error) {
    throw new CasePersistError(
      error instanceof Error ? error.message : "Spremanje slučaja nije uspjelo.",
    );
  }
}

export async function diagnoseContinue(input: {
  caseId: string;
  stepId: string;
  observation: ObservationInput;
  image?: TurnImage;
  access: UsageAccess & { ok: true };
}): Promise<DiagnoseResponse> {
  const userId = userIdOf(input.access);
  const loaded = await loadOwnedCase(input.caseId, userId);
  if (!loaded) {
    throw new CaseNotFoundError("Slučaj nije pronađen.");
  }

  const { caseData, version } = loaded;
  const incoming = observationForCompare(
    input.stepId,
    input.observation,
    input.image,
  );

  if (turnAlreadyCompleted(caseData, input.stepId)) {
    const existing = caseData.observations.find((o) => o.stepId === input.stepId);
    if (existing && !sameObservation(existing, incoming)) {
      throw new ObservationConflictError(
        `Conflicting second result for step ${input.stepId}`,
      );
    }
    return responseFromCase(caseData, version);
  }

  const currentStep = caseData.steps[caseData.steps.length - 1];
  if (!currentStep) {
    throw new InvalidObservationError("Slučaj nema aktivni korak.");
  }

  if (input.stepId !== currentStep.id) {
    throw new CaseConflictError(
      "Korak više nije aktivan. Osvježi slučaj i pokušaj ponovno.",
    );
  }

  if (isTurnLocked(loaded)) {
    throw new CaseConflictError(
      "Slučaj se trenutačno obrađuje. Pokušaj ponovno za trenutak.",
    );
  }

  const lockToken = await tryAcquireTurnLock(
    input.caseId,
    version,
    input.stepId,
    userId,
  );
  if (!lockToken) {
    const again = await loadOwnedCase(input.caseId, userId);
    if (again && turnAlreadyCompleted(again.caseData, input.stepId)) {
      const existing = again.caseData.observations.find(
        (o) => o.stepId === input.stepId,
      );
      if (existing && !sameObservation(existing, incoming)) {
        throw new ObservationConflictError(
          `Conflicting second result for step ${input.stepId}`,
        );
      }
      return responseFromCase(again.caseData, again.version);
    }
    throw new CaseConflictError(
      "Slučaj se trenutačno obrađuje. Pokušaj ponovno za trenutak.",
    );
  }

  try {
    const result = await engine.continueCase(
      caseData,
      input.observation,
      input.image,
    );

    const caseVersion = await persistOrThrow(
      result.case,
      version,
      lockToken,
      userId,
    );
    return { ...result, caseVersion };
  } catch (error) {
    await releaseTurnLock(input.caseId, version, lockToken, userId);
    throw error;
  }
}
