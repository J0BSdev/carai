/** Cheap, diacritic-folding normalize for guard/compare matching. */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9čćžšđ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type DraftTextFields = {
  content?: string | null;
  rationale?: string | null;
  expectedResultHint?: string | null;
  confirmedFault?: string | null;
  testGuide?: string | null;
};

/** Concatenate the fields guards scan as one blob. Includes testGuide when the mechanic can see it. */
export function draftBlob(draft: DraftTextFields): string {
  return [
    draft.content,
    draft.rationale,
    draft.expectedResultHint,
    draft.confirmedFault,
    draft.testGuide,
  ]
    .filter(Boolean)
    .join("\n");
}
