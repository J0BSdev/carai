import type {
  AiActionType,
  DiagnosticCase,
  DiagnosticStep,
  HypothesisStatus,
} from "./types";

export type DiagnosticPhaseUi =
  | "POČETNE PROVJERE"
  | "SUŽAVANJE UZROKA"
  | "PROVJERA HIPOTEZE"
  | "DIJAGNOZA POTVRĐENA"
  | "VJEROJATAN UZROK";

export function actionLabel(actionType: AiActionType): string {
  switch (actionType) {
    case "ASK":
      return "PITANJE";
    case "TEST":
      return "TEST";
    case "FINISH":
      return "DIJAGNOZA";
  }
}

export function diagnosticStatusLabel(
  phase: "intake" | "active" | "completed",
  diagnosticCase: DiagnosticCase | null,
  nextStep: DiagnosticStep | null,
): DiagnosticPhaseUi {
  if (phase === "completed" || nextStep?.actionType === "FINISH") {
    const finish =
      nextStep?.actionType === "FINISH"
        ? nextStep
        : diagnosticCase?.steps.find((s) => s.actionType === "FINISH");
    if (finish?.diagnosisCertainty === "CONFIRMED") {
      return "DIJAGNOZA POTVRĐENA";
    }
    if (finish?.insufficientEvidence || finish?.diagnosisCertainty) {
      return "VJEROJATAN UZROK";
    }
    return "DIJAGNOZA POTVRĐENA";
  }

  const answered = diagnosticCase?.observations.length ?? 0;
  const hasSupported = (diagnosticCase?.steps ?? []).some((s) =>
    s.hypotheses?.some((h) => h.status === "supported"),
  );

  if (answered === 0) return "POČETNE PROVJERE";
  if (hasSupported || answered >= 3) return "PROVJERA HIPOTEZE";
  return "SUŽAVANJE UZROKA";
}

export type EvidenceKind =
  | "verified"
  | "assumption"
  | "weak"
  | "ruled_out";

export function evidenceBadgeMeta(kind: EvidenceKind): {
  label: string;
  className: string;
} {
  switch (kind) {
    case "verified":
      return {
        label: "potvrđeno",
        className:
          "border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]",
      };
    case "assumption":
      return {
        label: "pretpostavka",
        className:
          "border-[var(--amber)]/40 bg-[var(--amber-soft)] text-[var(--amber)]",
      };
    case "weak":
      return {
        label: "slab dokaz",
        className:
          "border-[var(--amber)]/35 bg-[var(--amber-soft)] text-[var(--amber)]",
      };
    case "ruled_out":
      return {
        label: "isključeno",
        className:
          "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]",
      };
  }
}

export function hypothesisToKind(status: HypothesisStatus): EvidenceKind {
  switch (status) {
    case "supported":
      return "verified";
    case "plausible":
      return "assumption";
    case "weakened":
      return "weak";
    case "ruled_out":
      return "ruled_out";
    default:
      return "assumption";
  }
}

export { latestHypotheses } from "./known-facts";

export function needsDualMeasurement(step: DiagnosticStep): boolean {
  const blob = [
    step.content,
    step.expectedResultHint,
    step.recommendedTest?.whatToRecord,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    (blob.includes("prije") && blob.includes("poslije")) ||
    (blob.includes("before") && blob.includes("after")) ||
    blob.includes("prije/poslije") ||
    blob.includes("prije i poslije")
  );
}
