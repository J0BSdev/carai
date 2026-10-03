import type { DiagnosticStep } from "./types";

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

/**
 * UI only: show a number field when the TEST instruction asks for a reading.
 * Does not classify the mechanic's answer.
 */
export function testRequiresNumericValue(step: DiagnosticStep): boolean {
  if (step.actionType !== "TEST") return false;

  const meta = normalizeResultText(
    `${step.diagnosticGoal ?? ""} ${step.testMethod ?? ""}`,
  );
  if (
    meta &&
    /(vrijednost|value|broj|numeric|raspon|range|kvantit|ocitan|ocitaj)/.test(
      meta,
    )
  ) {
    return true;
  }
  if (
    meta &&
    /(prisut|isprav|pass|fail|potvrd|kontinuitet|uredn|kvalitat|ima\/nema|da\/ne)/.test(
      meta,
    )
  ) {
    return false;
  }

  const n = normalizeResultText(
    [step.content, step.expectedResultHint, step.testGuide].filter(Boolean).join(" "),
  );

  if (
    (n.includes("prije") && n.includes("poslije")) ||
    (n.includes("before") && n.includes("after")) ||
    n.includes("prije/poslije") ||
    n.includes("prije i poslije")
  ) {
    return true;
  }

  if (
    /(zabiljez|zapis|upis|ocitaj|ocitan|unesi).{0,48}(vrijednost|broj|napon|otpor|struja|tlak|volt|ohm|amper|bar|temp)/.test(
      n,
    ) ||
    /\d+(?:[.,]\d+)?\s*(v|mv|a|ma|ohm|bar|kpa|c|%)/.test(n)
  ) {
    return true;
  }

  return false;
}
