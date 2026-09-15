import type { DiagnosticStep } from "./types";

export type TestResultInterpretation =
  | { kind: "PASS" }
  | { kind: "FAIL" }
  | { kind: "VALUE"; value: number; unit: string | null }
  | { kind: "AMBIGUOUS" };

/** Compact polarity stems (not full synonym dictionaries). */
const POS_STEMS = [
  "dob",
  "isprav",
  "uredn",
  "stim",
  "ok",
  "okay",
  "pass",
  "normal",
  "prisut",
  "radi",
  "klikc",
] as const;

const NEG_STEMS = [
  "los",
  "neisprav",
  "fail",
  "nedostaj",
  "prek",
  "kvar",
  "open",
] as const;

/** Nouns that mean "a problem" — "nema/bez X" of these is PASS. */
const PROBLEM_STEMS = [
  "problem",
  "gresk",
  "smetnj",
  "issue",
  "mana",
  "kvar",
] as const;

function normalizeResultText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ω/g, "ohm")
    // Croatian decimal comma must survive punctuation stripping ("12,4 V").
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^a-z0-9.%\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Detect skipped / can't-perform / unavailable observation text. */
export function isSkippedOrUnavailableResult(resultText: string): boolean {
  const n = normalizeResultText(resultText);
  if (!n) return false;
  return (
    n.includes("ne mogu izvesti") ||
    n.includes("preskocen") ||
    n.includes("preskoceno") ||
    n.includes("preskoci") ||
    /\bskipped\b/.test(n) ||
    n.includes("cant perform") ||
    n.includes("cannot perform") ||
    /\bunavailable\b/.test(n) ||
    n.includes("nije dostupan") ||
    n.includes("nije moguce izvesti") ||
    n.includes("test nedostupan")
  );
}

function stepContextBlob(step: DiagnosticStep): string {
  return [
    step.content,
    step.expectedResultHint,
    step.diagnosticTarget,
    step.diagnosticGoal,
    step.testMethod,
    step.recommendedTest?.name,
    step.recommendedTest?.whatToRecord,
    step.recommendedTest?.specs?.value,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * True when the active TEST diagnostically depends on a concrete numeric reading.
 * Uses diagnosticGoal/testMethod when present; otherwise instruction text.
 */
export function testRequiresNumericValue(step: DiagnosticStep): boolean {
  if (step.actionType !== "TEST") return false;

  const goal = normalizeResultText(step.diagnosticGoal ?? "");
  const method = normalizeResultText(step.testMethod ?? "");
  const meta = `${goal} ${method}`.trim();

  // Goal/method explicitly about a quantitative reading.
  if (
    meta &&
    /(vrijednost|value|broj|numeric|raspon|range|kvantit|mjerenje vrijed|measure value|ocitan|ocitaj)/.test(
      meta,
    )
  ) {
    return true;
  }
  // Goal about presence/correctness → qualitative OK.
  if (
    meta &&
    /(prisut|isprav|pass|fail|potvrd|kontinuitet|uredn|kvalitat|ima\/nema|da\/ne)/.test(
      meta,
    )
  ) {
    return false;
  }

  const raw = stepContextBlob(step);
  const n = normalizeResultText(raw);

  // Before/after style measurements need numbers.
  if (
    (n.includes("prije") && n.includes("poslije")) ||
    (n.includes("before") && n.includes("after")) ||
    n.includes("prije/poslije") ||
    n.includes("prije i poslije")
  ) {
    return true;
  }

  // Instruction explicitly asks to record/read a value.
  if (
    /(zabiljez|zapis|upis|ocitaj|ocitan|unesi).{0,48}(vrijednost|broj|napon|otpor|struja|tlak|volt|ohm|amper|bar|temp)/.test(
      n,
    ) ||
    /(vrijednost|brojcan|numeric|reading).{0,32}(napon|otpor|struja|tlak|volt|ohm|\bv\b)/.test(
      n,
    ) ||
    /(koliko|tocan|tocnu|izmjerenu|izmjerena)\s+(je\s+)?(napon|otpor|struja|tlak|vrijednost)/.test(
      n,
    ) ||
    /(actual\s*vs\s*expected|izmjereno\s*vs|usporedi.{0,24}(raspon|spec|oem|ocekiv))/.test(
      n,
    )
  ) {
    return true;
  }

  // Concrete numeric target already in the test text.
  if (
    /\d+(?:[.,]\d+)?\s*(?:-|–|—|do|to)\s*\d+(?:[.,]\d+)?\s*(v|mv|a|ma|ohm|bar|kpa|c|%)/.test(
      n,
    ) ||
    /\d+(?:[.,]\d+)?\s*(v|mv|a|ma|ohm|bar|kpa|c|%)/.test(n)
  ) {
    return true;
  }

  return false;
}

/**
 * Whether the test context clearly allows a qualitative pass/fail answer
 * (presence, continuity, correctness) instead of a number.
 */
export function testAllowsQualitativeResult(step: DiagnosticStep): boolean {
  if (step.actionType !== "TEST") return false;
  if (testRequiresNumericValue(step)) return false;
  return true;
}

function tokenHasStem(token: string, stems: readonly string[]): boolean {
  if (!token) return false;
  return stems.some((s) => token === s || token.startsWith(s));
}

/**
 * Polarity with scoped negation:
 * - "ne radi" / "nije ispravno" / "nema napona" → FAIL
 * - "nije loš" / "ne prekida" / "nema problema" → PASS
 * Bare "ne/nije/nema/bez" alone does not auto-FAIL without reading the predicate.
 */
function detectPolarity(normalized: string): "pass" | "fail" | null {
  if (!normalized) return null;

  const neg = normalized.match(/\b(ne|nije|nema|bez|ni)\s+(\S+)/);
  if (neg) {
    const particle = neg[1];
    const predicate = neg[2] ?? "";

    // Negation of a bad/problem predicate → PASS
    if (
      tokenHasStem(predicate, NEG_STEMS) ||
      tokenHasStem(predicate, PROBLEM_STEMS)
    ) {
      return "pass";
    }

    // "nema/bez <desired thing>" → FAIL (absence), except problem-nouns above
    if (particle === "nema" || particle === "bez") {
      return "fail";
    }

    // "ne/nije <good predicate>" → FAIL
    if (tokenHasStem(predicate, POS_STEMS)) {
      return "fail";
    }

    // Unknown predicate after negation → ambiguous (do not auto-FAIL)
    return null;
  }

  const tokens = normalized.split(" ").filter(Boolean);
  let pos = 0;
  let negCount = 0;
  for (const t of tokens) {
    if (tokenHasStem(t, NEG_STEMS)) negCount += 1;
    if (tokenHasStem(t, POS_STEMS)) pos += 1;
  }

  if (negCount > 0 && pos === 0) return "fail";
  if (pos > 0 && negCount === 0) return "pass";
  if (pos > 0 && negCount > 0) return null;
  return null;
}

const UNIT_MAP: Record<string, string> = {
  v: "V",
  mv: "mV",
  a: "A",
  ma: "mA",
  ohm: "Ω",
  bar: "bar",
  kpa: "kPa",
  c: "°C",
  "%": "%",
  psi: "psi",
};

const READING_WITH_UNIT =
  /(-?\d+(?:[.,]\d+)?)\s*(v|mv|a|ma|ohm|bar|kpa|c|%|psi)\b/g;

/** Negation directly governing the number: "nema 12 V" states absence, not a reading. */
const NEGATED_BEFORE_VALUE = /\b(ne|nije|nema|bez|ni)\s+$/;

/** Reference target the mechanic quotes ("trebalo bi biti 12 V"), not a measurement. */
const REFERENCE_BEFORE_VALUE =
  /\b(trebalo bi|trebao bi|trebala bi|mora biti|ocekivan\w*|normalno je|po specifikaciji)\s+(?:biti\s+)?$/;

function textBefore(normalized: string, index: number | undefined): string {
  return normalized.slice(0, index ?? 0);
}

const MODAL_NUMBER = String.raw`-?\d+(?:[.,]\d+)?`;
/** Optional note suffix as ResultModal writes it: ` · napomena: …` (note may wrap). */
const MODAL_NOTE = String.raw`(?:\s*·\s*napomena:\s+[\s\S]+)`;
const MODAL_SINGLE = new RegExp(`^(${MODAL_NUMBER})(?:${MODAL_NOTE})?$`, "i");
const MODAL_DUAL = new RegExp(
  `^prije:\\s*(${MODAL_NUMBER})\\s*·\\s*poslije:\\s*(${MODAL_NUMBER})(?:${MODAL_NOTE})?$`,
  "i",
);

function parseNumberToken(raw: string): number | null {
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Exact ResultModal numeric payloads (raw, before punctuation folding).
 * Does not infer units and does not mine numbers from free-text answers.
 */
function parseResultModalNumeric(
  raw: string,
): { value: number; unit: null } | null {
  const single = raw.match(MODAL_SINGLE);
  if (single) {
    const value = parseNumberToken(single[1]);
    return value == null ? null : { value, unit: null };
  }
  const dual = raw.match(MODAL_DUAL);
  if (!dual) return null;
  const before = parseNumberToken(dual[1]);
  const after = parseNumberToken(dual[2]);
  if (before == null || after == null) return null;
  // Type holds one number; poslije is the later reading. Both stay in raw for AI.
  return { value: after, unit: null };
}

/**
 * Parse a measured VALUE from the mechanic's result text only.
 * Never invents a unit from the TEST instruction — a bare "12.4" stays unit: null.
 */
function parseValue(
  normalized: string,
  allowUnitlessValue: boolean,
): { value: number; unit: string | null } | null {
  // Range answers are not a single VALUE.
  if (
    /(-?\d+(?:[.,]\d+)?)\s*(?:-|–|—|do|to)\s*(-?\d+(?:[.,]\d+)?)/.test(
      normalized,
    )
  ) {
    return null;
  }

  // An explicit unit in the result marks a reading — unless a negation or a
  // quoted reference owns that number.
  for (const match of normalized.matchAll(READING_WITH_UNIT)) {
    const before = textBefore(normalized, match.index);
    if (NEGATED_BEFORE_VALUE.test(before)) continue;
    if (REFERENCE_BEFORE_VALUE.test(before)) continue;
    const value = Number(match[1].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const rawUnit = match[2].toLowerCase();
    return { value, unit: UNIT_MAP[rawUnit] ?? rawUnit };
  }

  // Bare number only when the step expects a reading and the answer is nothing
  // but that number. Incidental counts ("3 puta sam probao, ne radi") stay out.
  if (!allowUnitlessValue) return null;
  const bare = normalized.match(/^(-?\d+(?:[.,]\d+)?)$/);
  if (!bare) return null;
  const value = Number(bare[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return { value, unit: null };
}

/** True when the answer holds unit readings and every one of them is negated. */
function readingsAreNegatedAbsence(normalized: string): boolean {
  let sawReading = false;
  for (const match of normalized.matchAll(READING_WITH_UNIT)) {
    sawReading = true;
    if (!NEGATED_BEFORE_VALUE.test(textBefore(normalized, match.index))) {
      return false;
    }
  }
  return sawReading;
}

/**
 * Interpret a mechanic's test result in the context of the active TEST step.
 * No extra AI call — structural + light stem polarity only.
 */
export function interpretTestResult(
  step: DiagnosticStep,
  resultText: string,
): TestResultInterpretation {
  const trimmed = resultText.trim();
  if (!trimmed) return { kind: "AMBIGUOUS" };

  const allowUnitless = testRequiresNumericValue(step);
  if (allowUnitless) {
    const modal = parseResultModalNumeric(trimmed);
    if (modal) {
      return { kind: "VALUE", value: modal.value, unit: null };
    }
  }

  const normalized = normalizeResultText(trimmed);
  if (!normalized) return { kind: "AMBIGUOUS" };

  const numeric = parseValue(normalized, allowUnitless);
  if (numeric) {
    return { kind: "VALUE", value: numeric.value, unit: numeric.unit };
  }

  // "nema 12 V na konektoru" — the nominal value is what is missing, so it is a FAIL.
  if (readingsAreNegatedAbsence(normalized)) {
    return { kind: "FAIL" };
  }

  const polarity = detectPolarity(normalized);
  const allowsQualitative = testAllowsQualitativeResult(step);

  if (polarity === "fail") {
    return { kind: "FAIL" };
  }

  if (polarity === "pass") {
    if (allowsQualitative || !testRequiresNumericValue(step)) {
      return { kind: "PASS" };
    }
    // Numeric-required test got only qualitative praise → ambiguous.
    return { kind: "AMBIGUOUS" };
  }

  // Bare subject echo without polarity ("napon", "masa") → ambiguous.
  return { kind: "AMBIGUOUS" };
}

/**
 * A TEST result is completed evidence only when it interprets to VALUE/PASS/FAIL.
 * Skipped/unavailable and AMBIGUOUS never count as evidence.
 */
export function isCompletedTestEvidence(
  step: DiagnosticStep,
  resultText: string,
): boolean {
  if (!resultText.trim()) return false;
  if (isSkippedOrUnavailableResult(resultText)) return false;
  return interpretTestResult(step, resultText).kind !== "AMBIGUOUS";
}
