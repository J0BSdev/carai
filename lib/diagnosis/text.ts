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
  facts?: string[] | null;
  evidence?: string[] | null;
};

/** Concatenate the fields guards scan as one blob. */
export function draftBlob(draft: DraftTextFields): string {
  return [
    draft.content,
    draft.rationale,
    draft.expectedResultHint,
    draft.confirmedFault,
    ...(draft.facts ?? []),
    ...(draft.evidence ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}
