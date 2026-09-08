import type {
  AiActionType,
  DiagnosticCase,
  DiagnosticStep,
  Hypothesis,
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
    case "SEARCH_WEB":
      return "PRETRAGA";
    case "FINISH":
      return "DIJAGNOZA";
  }
}

export function vehicleMake(diagnosticCase: DiagnosticCase): string {
  const make = diagnosticCase.extracted?.vehicle?.make?.trim();
  if (make) return make.toUpperCase();
  const first = diagnosticCase.problemText.trim().split(/\s+/)[0];
  return (first || "VOZILO").toUpperCase();
}

export function vehicleSubtitle(diagnosticCase: DiagnosticCase): string {
  const v = diagnosticCase.extracted?.vehicle;
  const bits = [v?.model, v?.year, v?.engine].filter(Boolean);
  if (bits.length > 0) return bits.join(" · ");
  const line = diagnosticCase.problemText.split(/[.\n]/)[0]?.trim() ?? "";
  return line.length > 72 ? `${line.slice(0, 69)}…` : line;
}

export function vehicleTitle(diagnosticCase: DiagnosticCase): string {
  const v = diagnosticCase.extracted?.vehicle;
  const bits = [v?.make, v?.model, v?.year, v?.engine].filter(Boolean);
  if (bits.length > 0) return bits.join(" · ");
  return vehicleSubtitle(diagnosticCase);
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
    if (finish?.insufficientEvidence) return "VJEROJATAN UZROK";
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

export function statusProgress(
  label: DiagnosticPhaseUi,
): { index: number; total: number } {
  const order: DiagnosticPhaseUi[] = [
    "POČETNE PROVJERE",
    "SUŽAVANJE UZROKA",
    "PROVJERA HIPOTEZE",
    "DIJAGNOZA POTVRĐENA",
  ];
  if (label === "VJEROJATAN UZROK") {
    return { index: 3, total: 4 };
  }
  return { index: order.indexOf(label) + 1, total: 4 };
}

export type EvidenceKind =
  | "verified"
  | "assumption"
  | "weak"
  | "fact"
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
    case "fact":
      return {
        label: "činjenica",
        className:
          "border-[var(--accent)]/30 bg-[var(--accent-soft)] text-[var(--accent)]",
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

export function latestHypotheses(diagnosticCase: DiagnosticCase): Hypothesis[] {
  for (let i = diagnosticCase.steps.length - 1; i >= 0; i -= 1) {
    const h = diagnosticCase.steps[i]?.hypotheses;
    if (h && h.length > 0) return h;
  }
  return [];
}

export function inferUnit(step: DiagnosticStep): string {
  const blob = [
    step.content,
    step.expectedResultHint,
    step.recommendedTest?.name,
    step.recommendedTest?.whatToRecord,
    step.recommendedTest?.specs?.value,
  ]
    .filter(Boolean)
    .join(" ");

  if (/\bmA\b|miliamper/i.test(blob)) return "mA";
  if (/\bA\b|amper/i.test(blob) && !/\bmA\b/i.test(blob)) return "A";
  if (/\bV\b|volt/i.test(blob)) return "V";
  if (/%|posto/i.test(blob)) return "%";
  if (/Ω|ohm|otpor/i.test(blob)) return "Ω";
  if (/bar|kPa|tlak/i.test(blob)) return "bar";
  if (/°C|stupanj|temp/i.test(blob)) return "°C";
  return "";
}

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

export function looksNumericTest(step: DiagnosticStep): boolean {
  if (step.actionType !== "TEST") return false;
  if (inferUnit(step)) return true;
  if (needsDualMeasurement(step)) return true;
  const blob = `${step.content} ${step.expectedResultHint ?? ""}`;
  return /\d|izmjer|napon|struja|otpor|tlak|mA|\bV\b|measure|voltage|current/i.test(
    blob,
  );
}

export const THINKING_MESSAGES = [
  "Analiziram dokaze…",
  "Pregledavam prethodne rezultate…",
  "Uspoređujem dokaze…",
  "Biram sljedeći dijagnostički korak…",
] as const;
