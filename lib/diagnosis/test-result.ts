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

function normalizeResultText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ω/g, "ohm")
    .replace(/[^a-z0-9.%\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function detectPolarity(normalized: string): "pass" | "fail" | null {
  if (!normalized) return null;

  // Structural negation before a predicate → FAIL
  // e.g. "ne radi", "nije uredno", "nema napajanja", "bez kontinuiteta"
  if (/\b(ne|nije|nema|bez|ni)\b/.test(normalized)) {
    return "fail";
  }

  const tokens = normalized.split(" ").filter(Boolean);
  let pos = 0;
  let neg = 0;
  for (const t of tokens) {
    if (tokenHasStem(t, NEG_STEMS)) neg += 1;
    if (tokenHasStem(t, POS_STEMS)) pos += 1;
  }

  if (neg > 0 && pos === 0) return "fail";
  if (pos > 0 && neg === 0) return "pass";
  if (pos > 0 && neg > 0) return null;
  return null;
}

function parseValue(
  normalized: string,
  fallbackUnit: string | null,
): { value: number; unit: string | null } | null {
  // Range answers are not a single VALUE.
  if (
    /(-?\d+(?:[.,]\d+)?)\s*(?:-|–|—|do|to)\s*(-?\d+(?:[.,]\d+)?)/.test(
      normalized,
    )
  ) {
    return null;
  }

  const m = normalized.match(
    /(-?\d+(?:[.,]\d+)?)\s*(v|mv|a|ma|ohm|bar|kpa|c|%|psi)?\b/,
  );
  if (!m) return null;

  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;

  const rawUnit = (m[2] ?? "").toLowerCase();
  const unitMap: Record<string, string> = {
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
  const unit = rawUnit ? (unitMap[rawUnit] ?? rawUnit) : fallbackUnit;
  return { value, unit };
}

function inferFallbackUnit(step: DiagnosticStep): string | null {
  const blob = stepContextBlob(step);
  if (/\bmA\b|miliamper/i.test(blob)) return "mA";
  if (/\bA\b|amper/i.test(blob) && !/\bmA\b/i.test(blob)) return "A";
  if (/\bV\b|volt/i.test(blob)) return "V";
  if (/%|posto/i.test(blob)) return "%";
  if (/Ω|ohm|otpor/i.test(blob)) return "Ω";
  if (/bar|kPa|tlak/i.test(blob)) return "bar";
  if (/°C|stupanj|temp/i.test(blob)) return "°C";
  return null;
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

  const normalized = normalizeResultText(trimmed);
  if (!normalized) return { kind: "AMBIGUOUS" };

  const fallbackUnit = inferFallbackUnit(step);
  const numeric = parseValue(normalized, fallbackUnit);
  if (numeric) {
    return { kind: "VALUE", value: numeric.value, unit: numeric.unit };
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
