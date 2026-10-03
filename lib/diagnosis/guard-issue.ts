import type { DiagnosisCertainty } from "./types";

/** Stable id for guard routing. Never inferred from `message`. */
export type GuardIssueCode =
  | "TECHNICIAN_OUTCOME"
  | "SAFETY_REJECT"
  | "SPEC"
  | "CONFIRMATION"
  | "TEST_META";

export type GuardIssue = {
  code: GuardIssueCode;
  /** Shown to the model and logs. Not used for control flow. */
  message: string;
  /** Confirmation downgrade target, set at the issue source. */
  downgradeTo?: Extract<DiagnosisCertainty, "LIKELY" | "HIGH_CONFIDENCE">;
};

export function issue(
  code: GuardIssueCode,
  message: string,
  extra?: Pick<GuardIssue, "downgradeTo">,
): GuardIssue {
  return extra ? { code, message, ...extra } : { code, message };
}

export function issueOrNull(
  code: GuardIssueCode,
  message: string | null,
): GuardIssue | null {
  if (!message) return null;
  return issue(code, message);
}
