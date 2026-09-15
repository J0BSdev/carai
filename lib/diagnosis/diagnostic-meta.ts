import type { DiagnosticStep } from "./types";
import { normalizeForCompare } from "./text";

/**
 * Branch-identity metadata for a TEST.
 * Filled by the diagnostic model; optional on legacy steps.
 */
export type DiagnosticTestMeta = {
  content?: string | null;
  diagnosticTarget?: string | null;
  diagnosticGoal?: string | null;
  testMethod?: string | null;
};

export function normalizeMetaKey(value: string | null | undefined): string {
  return normalizeForCompare(value ?? "");
}

export function metaKeysEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeMetaKey(a);
  const nb = normalizeMetaKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Soft match: one contains the other (short AI paraphrases).
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) {
    return true;
  }
  return false;
}

export function metaFromDraft(draft: {
  content?: string | null;
  diagnosticTarget?: string | null;
  diagnosticGoal?: string | null;
  testMethod?: string | null;
}): DiagnosticTestMeta {
  return {
    content: draft.content ?? null,
    diagnosticTarget: draft.diagnosticTarget ?? null,
    diagnosticGoal: draft.diagnosticGoal ?? null,
    testMethod: draft.testMethod ?? null,
  };
}

function stripGenericTokens(normalized: string): string {
  const generic = new Set([
    "izmjeriti",
    "izmjeri",
    "mjerenje",
    "izmjer",
    "provjeriti",
    "provjeri",
    "provjera",
    "testirati",
    "test",
    "ocitati",
    "ocitaj",
    "vrijednost",
    "rezultat",
    "ponovno",
    "ponovo",
    "zatim",
    "paljenje",
    "vozilo",
  ]);
  return normalized
    .split(" ")
    .filter((w) => w.length > 3 && !generic.has(w))
    .join(" ");
}

function tokenOverlap(
  a: string,
  b: string,
): { ratio: number; inter: number } {
  const ta = new Set(a.split(" ").filter((w) => w.length > 3));
  const tb = new Set(b.split(" ").filter((w) => w.length > 3));
  if (ta.size === 0 || tb.size === 0) return { ratio: 0, inter: 0 };
  let inter = 0;
  for (const w of ta) {
    if (tb.has(w)) inter += 1;
  }
  return { ratio: inter / Math.min(ta.size, tb.size), inter };
}

/**
 * Legacy fallback when metadata is missing (old cases / incomplete drafts).
 * Lexical only — no automotive component/site dictionaries.
 */
export function legacyLexicalSameBranch(
  contentA: string,
  contentB: string,
): boolean {
  const a = normalizeForCompare(contentA);
  const b = normalizeForCompare(contentB);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const { ratio, inter } = tokenOverlap(
    stripGenericTokens(a),
    stripGenericTokens(b),
  );
  return ratio >= 0.65 && inter >= 3;
}

/**
 * Same diagnostic branch using model metadata first, lexical fallback second.
 * Same diagnosticGoal ⇒ same branch (even if method wording differs).
 * Same diagnosticTarget with missing/equal goals ⇒ same branch.
 */
export function testsAreSameDiagnosticBranch(
  a: DiagnosticTestMeta | string,
  b: DiagnosticTestMeta | string,
): boolean {
  const A: DiagnosticTestMeta =
    typeof a === "string" ? { content: a } : a;
  const B: DiagnosticTestMeta =
    typeof b === "string" ? { content: b } : b;

  const goalA = A.diagnosticGoal;
  const goalB = B.diagnosticGoal;
  if (goalA && goalB && metaKeysEqual(goalA, goalB)) {
    return true;
  }

  const targetA = A.diagnosticTarget;
  const targetB = B.diagnosticTarget;
  if (targetA && targetB && metaKeysEqual(targetA, targetB)) {
    // Same target: treat as same branch unless goals clearly differ.
    if (!goalA || !goalB || metaKeysEqual(goalA, goalB)) {
      return true;
    }
  }

  // Both sides lack usable meta → legacy lexical fallback.
  const hasMetaA = Boolean(goalA || targetA);
  const hasMetaB = Boolean(goalB || targetB);
  if (!hasMetaA || !hasMetaB) {
    return legacyLexicalSameBranch(A.content ?? "", B.content ?? "");
  }

  return false;
}

/** Stable key for independent-evidence family counting. */
export function diagnosticEvidenceFamilyKey(
  step: Pick<
    DiagnosticStep,
    "content" | "diagnosticTarget" | "diagnosticGoal" | "testMethod"
  >,
): string {
  const goal = normalizeMetaKey(step.diagnosticGoal);
  if (goal) return `goal:${goal}`;
  const target = normalizeMetaKey(step.diagnosticTarget);
  if (target) return `target:${target}`;
  const method = normalizeMetaKey(step.testMethod);
  if (method) return `method:${method}`;
  const content = normalizeMetaKey(step.content).slice(0, 40);
  return content ? `legacy:${content}` : "unknown";
}
