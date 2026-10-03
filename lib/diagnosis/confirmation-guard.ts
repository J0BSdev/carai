import type { DiagnosisCertainty, Hypothesis, TechnicianOutcome } from "./types";
import { isConfirmedTechnicianOutcome } from "./known-facts";
import { issueOrNull, type GuardIssue } from "./guard-issue";

export type FinishDraft = {
  actionType?: string;
  confirmedFault?: string | null;
  diagnosisCertainty?: string | null;
  insufficientEvidence?: boolean | null;
};

/** Accept only the certainty enum. Aliases fold; anything else is not CONFIRMED. */
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

/** Never invent CONFIRMED from a missing or unknown certainty. */
export function resolveDiagnosisCertainty(
  draft: FinishDraft,
): DiagnosisCertainty {
  return normalizeDiagnosisCertainty(draft.diagnosisCertainty) ?? "LIKELY";
}

/**
 * Typed technicianOutcome vs actionType. Does not read mechanic prose.
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
      return "TECHNICIAN OUTCOME: FAULT_CONFIRMED zahtijeva technicianOutcome.fault ili confirmedFault.";
    }
  }

  return null;
}

/** Model status words → the four UI statuses. Unknown stays plausible. */
export function mapHypothesisUiStatus(status: string): Hypothesis["status"] {
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
