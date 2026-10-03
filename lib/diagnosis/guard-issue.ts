/** Stable id for guard routing. Never inferred from `message`. */
export type GuardIssueCode =
  | "TECHNICIAN_OUTCOME"
  | "SAFETY_REJECT"
  | "SPEC"
  | "TEST_META";

export type GuardIssue = {
  code: GuardIssueCode;
  /** Shown to the model and logs. Not used for control flow. */
  message: string;
};

export function issue(code: GuardIssueCode, message: string): GuardIssue {
  return { code, message };
}

export function issueOrNull(
  code: GuardIssueCode,
  message: string | null,
): GuardIssue | null {
  if (!message) return null;
  return issue(code, message);
}
