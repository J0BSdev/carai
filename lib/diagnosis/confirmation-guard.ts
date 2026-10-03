import type { TechnicianOutcome } from "./types";
import { issueOrNull, type GuardIssue } from "./guard-issue";

export type FinishDraft = {
  actionType?: string;
};

/**
 * Confirmed outcome is only legal on FINISH.
 * Does not read mechanic prose. Fault text is confirmedFault on the FINISH step.
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
  if (!technicianOutcome) return null;
  if (draft.actionType === "ASK" || draft.actionType === "TEST") {
    return (
      "TECHNICIAN OUTCOME: FAULT_CONFIRMED/REPAIR_CONFIRMED zahtijeva FINISH. " +
      "Inače izostavi technicianOutcome."
    );
  }
  return null;
}
