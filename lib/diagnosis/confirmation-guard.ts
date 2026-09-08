import type {
  DiagnosticCase,
  DiagnosisCertainty,
  Hypothesis,
} from "./types";
import { getVerifiedTechnicalSpecs } from "./spec-guard";

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9čćžšđ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type FinishDraft = {
  actionType?: string;
  content?: string;
  rationale?: string;
  confirmedFault?: string | null;
  diagnosisCertainty?: string | null;
  diagnosisConfidence?: number | null;
  confidence?: string | null;
  insufficientEvidence?: boolean | null;
  hypotheses?: Array<{
    label?: string;
    cause?: string;
    status?: string;
    confidence?: number | null;
  }> | null;
  evidence?: string[] | null;
  facts?: string[] | null;
};

export function normalizeDiagnosisCertainty(
  raw: string | null | undefined,
): DiagnosisCertainty | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (key === "SUSPECTED" || key === "SUSPECT") return "SUSPECTED";
  if (key === "LIKELY" || key === "PROBABLE") return "LIKELY";
  if (
    key === "HIGH_CONFIDENCE" ||
    key === "HIGHCONFIDENCE" ||
    key === "HIGH"
  ) {
    return "HIGH_CONFIDENCE";
  }
  if (key === "CONFIRMED" || key === "CONFIRM") return "CONFIRMED";
  return null;
}

/**
 * Resolve FINISH certainty. Never default to CONFIRMED from missing fields.
 * Legacy: insufficientEvidence true → LIKELY; false/missing → HIGH_CONFIDENCE.
 */
export function resolveDiagnosisCertainty(
  draft: FinishDraft,
): DiagnosisCertainty {
  const explicit = normalizeDiagnosisCertainty(draft.diagnosisCertainty);
  if (explicit) return explicit;
  if (draft.insufficientEvidence === true) return "LIKELY";
  if (draft.insufficientEvidence === false) return "HIGH_CONFIDENCE";
  return "LIKELY";
}

export function isTechnicianRejection(resultText: string): boolean {
  const n = normalizeForCompare(resultText);
  return (
    n.includes("technician_rejected") ||
    n.includes("technician rejected") ||
    n.includes("odbija predlozenu dijagnozu") ||
    n.includes("dijagnoza ne izgleda tocno") ||
    n.includes("ne izgleda tocno") ||
    n.includes("rejected_diagnosis")
  );
}

export function isContinueAfterFinish(resultText: string): boolean {
  const n = normalizeForCompare(resultText);
  return (
    n.includes("nastaviti dijagnostiku") ||
    n.includes("nastavi testiranje") ||
    n.includes("continue diagnosis") ||
    n.includes("keep diagnosing")
  );
}

export function diagnosisLabelKey(text: string): string {
  return normalizeForCompare(text)
    .replace(/\b(kvar|neispravan|fault|likely|high confidence|confirmed|suspected)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function wasDiagnosisRejected(
  diagnosticCase: DiagnosticCase,
  diagnosisText: string,
): boolean {
  const key = diagnosisLabelKey(diagnosisText);
  if (!key) return false;
  return (diagnosticCase.rejectedDiagnoses ?? []).some((r) => {
    const rk = diagnosisLabelKey(r.diagnosis);
    return (
      rk === key ||
      (rk.length >= 12 && key.includes(rk)) ||
      (key.length >= 12 && rk.includes(key))
    );
  });
}

function leadingHypothesisConfidence(draft: FinishDraft): number | null {
  if (typeof draft.diagnosisConfidence === "number") {
    return draft.diagnosisConfidence;
  }
  const hyps = draft.hypotheses ?? [];
  let best: number | null = null;
  for (const h of hyps) {
    if (typeof h.confidence !== "number") continue;
    const status = (h.status ?? "").toUpperCase();
    if (
      status.includes("RULED") ||
      status.includes("WEAK") ||
      status.includes("WEAKENED")
    ) {
      continue;
    }
    if (best == null || h.confidence > best) best = h.confidence;
  }
  return best;
}

function strongAlternativeExists(draft: FinishDraft): boolean {
  const hyps = draft.hypotheses ?? [];
  if (hyps.length < 2) return false;

  const ranked = hyps
    .map((h) => ({
      label: (h.label ?? h.cause ?? "").trim(),
      confidence: typeof h.confidence === "number" ? h.confidence : null,
      status: (h.status ?? "").toUpperCase().replace(/[\s-]+/g, "_"),
    }))
    .filter((h) => h.label && !h.status.includes("RULED"));

  if (ranked.length < 2) return false;

  ranked.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const lead = ranked[0];
  const alt = ranked[1];
  if (!lead || !alt) return false;

  // Explicit alternate still POSSIBLE/LEADING/LIKELY with meaningful share
  const altAlive =
    alt.status.includes("POSSIBLE") ||
    alt.status.includes("PLAUSIBLE") ||
    alt.status.includes("LEADING") ||
    alt.status.includes("LIKELY") ||
    alt.status.includes("SUPPORTED") ||
    alt.status === "";

  if (!altAlive && alt.status.includes("WEAK")) {
    return (alt.confidence ?? 0) >= 25;
  }

  if (alt.confidence == null) {
    return altAlive;
  }

  return alt.confidence >= 15;
}

function countCompletedTestFamilies(diagnosticCase: DiagnosticCase): number {
  const families = new Set<string>();
  for (const step of diagnosticCase.steps) {
    if (step.actionType !== "TEST") continue;
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    if (!obs?.resultText) continue;
    const n = normalizeForCompare(`${step.content} ${obs.resultText}`);
    if (/otpor|ohm/.test(n)) families.add("resistance");
    else if (/napon|volt/.test(n)) families.add("voltage");
    else if (/kontinuitet|masa|ground/.test(n)) families.add("continuity");
    else if (/skenir|dtc|kod/.test(n)) families.add("scan");
    else if (/vizual|pregled/.test(n)) families.add("visual");
    else if (/tlak|bar|kpa/.test(n)) families.add("pressure");
    else families.add(`other:${n.slice(0, 24)}`);
  }
  return families.size;
}

function hasIndependentConfirmatorySignal(
  diagnosticCase: DiagnosticCase,
  draft: FinishDraft,
): boolean {
  const families = countCompletedTestFamilies(diagnosticCase);
  const answers = diagnosticCase.steps.filter((s) => {
    if (s.actionType !== "ASK") return false;
    return diagnosticCase.observations.some(
      (o) => o.stepId === s.id && o.resultText?.trim(),
    );
  }).length;

  // Independent ≈ different test families (not just restated symptoms)
  if (families >= 2) return true;
  if (families >= 1 && answers >= 1 && (draft.evidence?.length ?? 0) >= 2) {
    return false; // still weak for CONFIRMED
  }
  return false;
}

function observationsAfterRejection(
  diagnosticCase: DiagnosticCase,
): number {
  const rejected = diagnosticCase.rejectedDiagnoses ?? [];
  if (rejected.length === 0) return 0;
  const last = rejected[rejected.length - 1];
  const after = last?.rejectedAt ? Date.parse(last.rejectedAt) : 0;
  if (!after) {
    // Fallback: any observation after rejection step
    return diagnosticCase.observations.length;
  }
  return diagnosticCase.observations.filter(
    (o) => Date.parse(o.recordedAt) > after,
  ).length;
}

function newIndependentEvidenceSinceRejection(
  diagnosticCase: DiagnosticCase,
): boolean {
  // Require at least one new completed TEST result after rejection timestamp
  const rejected = diagnosticCase.rejectedDiagnoses ?? [];
  if (rejected.length === 0) return true;
  const last = rejected[rejected.length - 1];
  const after = last?.rejectedAt ? Date.parse(last.rejectedAt) : 0;

  for (const step of diagnosticCase.steps) {
    if (step.actionType !== "TEST") continue;
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    if (!obs?.resultText?.trim()) continue;
    if (isTechnicianRejection(obs.resultText)) continue;
    if (isContinueAfterFinish(obs.resultText)) continue;
    if (!after || Date.parse(obs.recordedAt) > after) {
      // New test after rejection — treat as candidate independent evidence
      // Still not enough alone for auto-CONFIRMED; used only to unlock reconfirm path
      return observationsAfterRejection(diagnosticCase) >= 1 &&
        countCompletedTestFamilies(diagnosticCase) >= 2;
    }
  }
  return false;
}

function finishDependsOnUnverifiedSpec(draft: FinishDraft): boolean {
  const text = [
    draft.content,
    draft.rationale,
    draft.confirmedFault,
    ...(draft.evidence ?? []),
    ...(draft.facts ?? []),
  ]
    .filter(Boolean)
    .join("\n");
  return /(trebalo bi biti|mora biti|ocekivan|očekivan|normalno|tipicno|tipično|oem|referentni|specifikac|\d+\s*[–-]\s*\d+\s*Ω|\d+\s*ohm)/i.test(
    text,
  );
}

/**
 * Blocks unjustified CONFIRMED. Returns issue string or null.
 */
export function findConfirmationGuardIssue(
  diagnosticCase: DiagnosticCase,
  draft: FinishDraft,
): string | null {
  if (draft.actionType !== "FINISH") return null;

  const certainty = resolveDiagnosisCertainty(draft);
  if (certainty !== "CONFIRMED") return null;

  const diagnosisText =
    draft.confirmedFault?.trim() || draft.content?.trim() || "";

  if (
    wasDiagnosisRejected(diagnosticCase, diagnosisText) &&
    !newIndependentEvidenceSinceRejection(diagnosticCase)
  ) {
    return (
      "RECONFIRMATION GUARD: wasDiagnosisRejected===true i newIndependentConfirmatoryEvidence===false. " +
      "Ne smiješ vratiti CONFIRMED za odbijenu dijagnozu. Koristi LIKELY/HIGH_CONFIDENCE i diskriminirajući TEST/ASK."
    );
  }

  if (strongAlternativeExists(draft)) {
    return (
      "CONFIRMED GUARD: strongAlternativeStillExists===true. " +
      "Confidence != confirmation. Vrati HIGH_CONFIDENCE ili LIKELY, ne CONFIRMED."
    );
  }

  if (!hasIndependentConfirmatorySignal(diagnosticCase, draft)) {
    return (
      "CONFIRMED GUARD: nema dovoljno NEOVISNIH potvrđujućih dokaza. " +
      "Jedan simptom/DTC/lanac povezanih opažanja nije CONFIRMED. Vrati LIKELY ili HIGH_CONFIDENCE."
    );
  }

  if (
    finishDependsOnUnverifiedSpec(draft) &&
    getVerifiedTechnicalSpecs(diagnosticCase).length === 0
  ) {
    return (
      "CONFIRMED GUARD: exactTechnicalSpecWasRequired && specIsNotVerified. " +
      "Blokiran CONFIRMED. Vrati LIKELY/HIGH_CONFIDENCE bez neprovjerenih OEM brojki."
    );
  }

  // High % alone never justifies CONFIRMED
  const conf = leadingHypothesisConfidence(draft);
  if (conf != null && conf >= 80 && strongAlternativeExists(draft)) {
    return (
      "CONFIRMED GUARD: visoki confidence postotak nije potvrda. Status = HIGH_CONFIDENCE."
    );
  }

  return null;
}

/** Downgrade illegal CONFIRMED drafts to HIGH_CONFIDENCE / LIKELY. */
export function downgradeUnjustifiedConfirmed(
  draft: FinishDraft,
  issue: string,
): FinishDraft {
  const toLikely = /RECONFIRMATION|specIsNotVerified|UNVERIFIED/i.test(issue);
  const certainty: DiagnosisCertainty = toLikely
    ? "LIKELY"
    : "HIGH_CONFIDENCE";
  return {
    ...draft,
    diagnosisCertainty: certainty,
    insufficientEvidence: true,
    confidence:
      certainty === "LIKELY"
        ? "medium"
        : draft.confidence === "low"
          ? "medium"
          : (draft.confidence as "low" | "medium" | "high" | null | undefined) ??
            "high",
    rationale: `${draft.rationale ?? ""}\n\n[${certainty}: CONFIRMED odbijen — ${issue.slice(0, 180)}]`.trim(),
  };
}

export function mapHypothesisUiStatus(
  status: string,
): Hypothesis["status"] {
  const key = status.trim().toUpperCase().replace(/[\s-]+/g, "_");
  switch (key) {
    case "LEADING":
    case "SUPPORTED":
    case "LIKELY":
    case "HIGH_CONFIDENCE":
    case "CONFIRMED":
      return "supported";
    case "POSSIBLE":
    case "PLAUSIBLE":
    case "SUSPECTED":
      return "plausible";
    case "WEAK":
    case "WEAKENED":
      return "weakened";
    case "RULED_OUT":
      return "ruled_out";
    default:
      return "plausible";
  }
}
