/** Parse a verifier gate. Correction fields are ignored; the verifier does not edit the draft. */
export function parseVerifierVerdict(raw: {
  approved?: unknown;
  issues?: unknown;
}): { approved: boolean; issues: string[] } {
  const issues: string[] = [];
  if (Array.isArray(raw.issues)) {
    for (const item of raw.issues) {
      if (typeof item !== "string" || !item.trim()) continue;
      issues.push(item.trim());
      if (issues.length >= 2) break;
    }
  }
  return {
    approved: raw.approved === true && issues.length === 0,
    issues,
  };
}
