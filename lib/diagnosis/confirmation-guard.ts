import type {
  DiagnosticCase,
  DiagnosisCertainty,
  Hypothesis,
  TechnicianOutcome,
} from "./types";
import { getVerifiedTechnicalSpecs } from "./spec-guard";
import { diagnosticEvidenceFamilyKey } from "./diagnostic-meta";
import { isCompletedTestEvidence } from "./test-result";
import { normalizeForCompare } from "./text";
import { isConfirmedTechnicianOutcome } from "./known-facts";
import { issue, issueOrNull, type GuardIssue } from "./guard-issue";

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

/** Legacy fail-safe only. New observations carry UserContinueIntent and must not be routed by this. */
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

/** Legacy fail-safe only. New observations carry UserContinueIntent and must not be routed by this. */
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

/** Only VALUE/PASS/FAIL results count — skipped and AMBIGUOUS are not evidence. */
function countCompletedTestFamilies(diagnosticCase: DiagnosticCase): number {
  const families = new Set<string>();
  for (const step of diagnosticCase.steps) {
    if (step.actionType !== "TEST") continue;
    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    if (!obs?.resultText) continue;
    if (!isCompletedTestEvidence(step, obs.resultText)) continue;
    families.add(diagnosticEvidenceFamilyKey(step));
  }
  return families.size;
}

function hasIndependentConfirmatorySignal(
  diagnosticCase: DiagnosticCase,
  draft: FinishDraft,
  technicianOutcome?: TechnicianOutcome | null,
): boolean {
  if (
    draft.actionType === "FINISH" &&
    isConfirmedTechnicianOutcome(technicianOutcome)
  ) {
    return true;
  }

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
    if (obs.intent === "SKIP" || obs.intent === "CANNOT_PERFORM") continue;
    if (
      obs.intent === "REJECT_DIAGNOSIS" ||
      obs.intent === "CONTINUE_AFTER_FINISH"
    ) {
      continue;
    }
    if (!obs.intent) {
      if (isTechnicianRejection(obs.resultText)) continue;
      if (isContinueAfterFinish(obs.resultText)) continue;
    }
    if (!isCompletedTestEvidence(step, obs.resultText)) continue;
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
 * Confirmed mechanic stance on this turn vs Claude's actionType.
 * Does not parse mechanic prose — only the typed AI extraction.
 */
export function findTechnicianOutcomeConsistencyIssue(
  technicianOutcome: TechnicianOutcome | null | undefined,
  draft: FinishDraft,
): GuardIssue | null {
  return issueOrNull(
    "TECHNICIAN_OUTCOME",
    technicianOutcomeConsistencyMessage(technicianOutcome, draft),
  );
}

function technicianOutcomeConsistencyMessage(
  technicianOutcome: TechnicianOutcome | null | undefined,
  draft: FinishDraft,
): string | null {
  if (!isConfirmedTechnicianOutcome(technicianOutcome)) return null;

  if (draft.actionType === "ASK" || draft.actionType === "TEST") {
    return (
      "TECHNICIAN OUTCOME: ovaj mechanic result je FAULT_CONFIRMED/REPAIR_CONFIRMED. " +
      "actionType mora biti FINISH. Reevaluate kao FINISH, ne ASK/TEST."
    );
  }

  if (
    draft.actionType === "FINISH" &&
    technicianOutcome?.status === "FAULT_CONFIRMED"
  ) {
    const fault =
      technicianOutcome.fault?.trim() || draft.confirmedFault?.trim();
    if (!fault) {
      return (
        "TECHNICIAN OUTCOME: FAULT_CONFIRMED zahtijeva technicianOutcome.fault ili confirmedFault."
      );
    }
  }

  return null;
}

/**
 * Blocks unjustified CONFIRMED. Returns issue string or null.
 * `technicianOutcome` is the current turn extraction only — never persisted case facts.
 */
export function findConfirmationGuardIssue(
  diagnosticCase: DiagnosticCase,
  draft: FinishDraft,
  technicianOutcome?: TechnicianOutcome | null,
): GuardIssue | null {
  const found = confirmationGuardMessage(diagnosticCase, draft, technicianOutcome);
  if (!found) return null;
  return issue("CONFIRMATION", found.message, { downgradeTo: found.downgradeTo });
}

function confirmationGuardMessage(
  diagnosticCase: DiagnosticCase,
  draft: FinishDraft,
  technicianOutcome?: TechnicianOutcome | null,
): { message: string; downgradeTo: "LIKELY" | "HIGH_CONFIDENCE" } | null {
  if (draft.actionType !== "FINISH") return null;

  const certainty = resolveDiagnosisCertainty(draft);
  if (certainty !== "CONFIRMED") return null;

  const turnConfirmed =
    isConfirmedTechnicianOutcome(technicianOutcome) &&
    draft.actionType === "FINISH";

  const diagnosisText =
    draft.confirmedFault?.trim() || draft.content?.trim() || "";

  if (!turnConfirmed) {
    if (
      wasDiagnosisRejected(diagnosticCase, diagnosisText) &&
      !newIndependentEvidenceSinceRejection(diagnosticCase)
    ) {
      return {
        downgradeTo: "LIKELY",
        message:
          "RECONFIRMATION GUARD: wasDiagnosisRejected===true i newIndependentConfirmatoryEvidence===false. " +
          "Ne smiješ vratiti CONFIRMED za odbijenu dijagnozu. Koristi LIKELY/HIGH_CONFIDENCE i diskriminirajući TEST/ASK.",
      };
    }

    if (strongAlternativeExists(draft)) {
      return {
        downgradeTo: "HIGH_CONFIDENCE",
        message:
          "CONFIRMED GUARD: strongAlternativeStillExists===true. " +
          "Confidence != confirmation. Vrati HIGH_CONFIDENCE ili LIKELY, ne CONFIRMED.",
      };
    }
  }

  if (!hasIndependentConfirmatorySignal(diagnosticCase, draft, technicianOutcome)) {
    return {
      downgradeTo: "HIGH_CONFIDENCE",
      message:
        "CONFIRMED GUARD: nema dovoljno NEOVISNIH potvrđujućih dokaza. " +
        "Jedan simptom/DTC/lanac povezanih opažanja nije CONFIRMED. Vrati LIKELY ili HIGH_CONFIDENCE.",
    };
  }

  if (
    !turnConfirmed &&
    finishDependsOnUnverifiedSpec(draft) &&
    getVerifiedTechnicalSpecs(diagnosticCase).length === 0
  ) {
    return {
      downgradeTo: "LIKELY",
      message:
        "CONFIRMED GUARD: exactTechnicalSpecWasRequired && specIsNotVerified. " +
        "Blokiran CONFIRMED. Vrati LIKELY/HIGH_CONFIDENCE bez neprovjerenih OEM brojki.",
    };
  }

  // High % alone never justifies CONFIRMED
  const conf = leadingHypothesisConfidence(draft);
  if (
    !turnConfirmed &&
    conf != null &&
    conf >= 80 &&
    strongAlternativeExists(draft)
  ) {
    return {
      downgradeTo: "HIGH_CONFIDENCE",
      message:
        "CONFIRMED GUARD: visoki confidence postotak nije potvrda. Status = HIGH_CONFIDENCE.",
    };
  }

  return null;
}

/** Downgrade illegal CONFIRMED drafts to HIGH_CONFIDENCE / LIKELY. */
export function downgradeUnjustifiedConfirmed(
  draft: FinishDraft,
  guardIssue: GuardIssue,
): FinishDraft {
  const certainty: DiagnosisCertainty =
    guardIssue.downgradeTo === "LIKELY" ? "LIKELY" : "HIGH_CONFIDENCE";
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
    rationale: `${draft.rationale ?? ""}\n\n[${certainty}: CONFIRMED odbijen — ${guardIssue.message.slice(0, 180)}]`.trim(),
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
