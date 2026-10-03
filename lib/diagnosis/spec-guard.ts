import type { DiagnosticCase, TechnicalSpecClaim } from "./types";
import { draftBlob } from "./text";
import { issueOrNull, type GuardIssue } from "./guard-issue";

export type { TechnicalSpecClaim };

/**
 * Lowercase + strip diacritics. Patterns below are ASCII, so raw Croatian
 * ("očekivani", "tipično") must be folded first or the guard misses it.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Vehicle-specific REFERENCE claims (expected/OEM/typical ranges), not measured evidence. */
export function extractReferenceSpecClaims(text: string): TechnicalSpecClaim[] {
  if (!text?.trim()) return [];

  const claims: TechnicalSpecClaim[] = [];
  const normalized = text.replace(/\u00a0/g, " ");

  // Range or single expected values with technical units
  // Note: do not use \b after Ω — Ω is non-word in JS so \b never matches.
  const pattern =
    /(?:~?\s*)(\d+(?:[.,]\d+)?)\s*(?:–|-|—|do|to)\s*(?:~?\s*)(\d+(?:[.,]\d+)?)\s*(Ω|ohm|ohma|V|v|mV|bar|kPa|psi|°C|C|Nm|N·m|A|mA|%)(?=$|[\s,.;:)/|]|(?=[^\d]))|(?:~?\s*)(\d+(?:[.,]\d+)?)\s*(Ω|ohm|ohma|V|v|mV|bar|kPa|psi|°C|C|Nm|N·m|A|mA|%)(?=$|[\s,.;:)/|]|(?=[^\d]))/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const idx = match.index;
    const before = normalized.slice(Math.max(0, idx - 48), idx);
    const after = normalized.slice(idx, Math.min(normalized.length, idx + match[0].length + 24));
    const context = `${before} ${after}`;
    const contextLower = fold(context);

    // Skip measured evidence phrasing
    if (isMeasuredEvidenceContext(contextLower)) continue;

    let low: number | null = null;
    let high: number | null = null;
    let unit = "";
    const valueText = match[0].trim();

    if (match[1] != null && match[2] != null) {
      low = parseNum(match[1]);
      high = parseNum(match[2]);
      unit = normalizeUnit(match[3] || "");
    } else if (match[4] != null) {
      // Single number — only treat as reference if nearby expects/OEM language
      if (!isReferenceLanguage(contextLower)) continue;
      low = parseNum(match[4]);
      high = low;
      unit = normalizeUnit(match[5] || "");
    } else {
      continue;
    }

    if (!unit) continue;

    // Ranges always count as potential reference specs when unit is technical;
    // single values need reference language (handled above).
    if (match[1] != null && !isReferenceLanguage(contextLower)) {
      // Bare ranges in measurement instructions may be OK only if marked unverified
      // Still treat as reference claim if they look like empty/full sender maps etc.
      if (!looksLikeSpecTable(contextLower)) continue;
    }

    const family = unitFamily(unit);
    claims.push({
      parameterKey: family,
      label: family,
      valueText,
      unit,
      low,
      high,
    });
  }

  return dedupeClaims(claims);
}

function parseNum(raw: string): number {
  return Number.parseFloat(raw.replace(",", ".").replace("~", "").trim());
}

function normalizeUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (u === "ohm" || u === "ohma" || u === "ω") return "Ω";
  if (u === "c") return "°C";
  if (u === "n·m") return "Nm";
  if (u === "v") return "V";
  return unit.trim();
}

function unitFamily(unit: string): string {
  const u = unit.toLowerCase();
  if (u === "ω" || u === "ohm") return "resistance";
  if (u === "v" || u === "mv") return "voltage";
  if (u === "a" || u === "ma") return "current";
  if (u === "bar" || u === "kpa" || u === "psi") return "pressure";
  if (u === "°c" || u === "c") return "temperature";
  if (u === "nm") return "torque";
  if (u === "%") return "percent";
  return u || "value";
}

function isMeasuredEvidenceContext(contextLower: string): boolean {
  return (
    /izmjeren|izmjereno|izmjerili|ocitano|rezultat\s*:|measured|reading\s*:|dobiveno|dobili smo|korisnik/.test(
      contextLower,
    ) && !/ocekivan|trebalo|trebao|trebala|normalno|tipicno|oem|spec/.test(contextLower)
  );
}

function isReferenceLanguage(contextLower: string): boolean {
  return /ocekivan|trebalo bi|trebao bi|trebala bi|treba biti|mora biti|normalno|tipicno|oem|specifikac|referent|raspon|range|prazan|pun\b|empty|full|priblizn|~|za ovo vozilo|na ovom vozilu|factory|datasheet/.test(
    contextLower,
  );
}

function looksLikeSpecTable(contextLower: string): boolean {
  return /prazan|pun\b|empty|full|min\b|max\b|raspon|referent|ocekivan|normalno|tipicno/.test(
    contextLower,
  );
}

function dedupeClaims(claims: TechnicalSpecClaim[]): TechnicalSpecClaim[] {
  const map = new Map<string, TechnicalSpecClaim>();
  for (const c of claims) {
    const prev = map.get(c.parameterKey);
    if (!prev) {
      map.set(c.parameterKey, c);
      continue;
    }
    // Keep first; conflicts handled elsewhere
  }
  return [...map.values()];
}

function isExplicitlyUnverifiedStatement(text: string): boolean {
  return /nije verificiran|nije potvrden|unverified|specstatus\s*=\s*unverified|tocan referentni raspon.*nije|nemam verificiran|bez verificiran/.test(
    fold(text),
  );
}

export function rangesConflict(
  a: Pick<TechnicalSpecClaim, "low" | "high">,
  b: Pick<TechnicalSpecClaim, "low" | "high">,
): boolean {
  if (a.low == null || a.high == null || b.low == null || b.high == null) {
    return false;
  }
  const span = Math.max(
    Math.abs(a.high - a.low),
    Math.abs(b.high - b.low),
    1,
  );
  const tol = Math.max(5, span * 0.15);
  return Math.abs(a.low - b.low) > tol || Math.abs(a.high - b.high) > tol;
}

/** Collect reference claims already present in case history (locked for consistency). */
export function collectHistoricalReferenceClaims(
  diagnosticCase: DiagnosticCase,
): TechnicalSpecClaim[] {
  const fromSteps: TechnicalSpecClaim[] = [];
  for (const step of diagnosticCase.steps) {
    fromSteps.push(...extractReferenceSpecClaims(draftBlob(step)));
  }
  return dedupeClaims(fromSteps);
}

/**
 * Reject invented vehicle-specific reference numbers and contradictory claims.
 * AI-generated claims never count as VERIFIED.
 */
export function findSpecGuardIssue(
  diagnosticCase: DiagnosticCase,
  draft: {
    actionType?: string;
    content?: string;
    rationale?: string;
    expectedResultHint?: string | null;
    confirmedFault?: string | null;
    facts?: string[] | null;
    evidence?: string[] | null;
    confidence?: string | null;
  },
): GuardIssue | null {
  return issueOrNull("SPEC", specGuardMessage(diagnosticCase, draft));
}

function specGuardMessage(
  diagnosticCase: DiagnosticCase,
  draft: {
    actionType?: string;
    content?: string;
    rationale?: string;
    expectedResultHint?: string | null;
    confirmedFault?: string | null;
    facts?: string[] | null;
    evidence?: string[] | null;
    confidence?: string | null;
  },
): string | null {
  const text = draftBlob(draft);
  if (!text.trim()) return null;

  const historical = collectHistoricalReferenceClaims(diagnosticCase);
  const newClaims = extractReferenceSpecClaims(text);

  for (const neu of newClaims) {
    const prev = historical.find((h) => h.parameterKey === neu.parameterKey);
    if (prev && rangesConflict(prev, neu)) {
      return (
        `CONSISTENCY: kontradiktorna referentna specifikacija za ${neu.parameterKey}. ` +
        `PREVIOUS: ${prev.valueText}; NEW: ${neu.valueText}. ` +
        "Ne mijenjaj tehničke referentne vrijednosti unutar istog slučaja."
      );
    }
  }

  for (const claim of newClaims) {
    if (isExplicitlyUnverifiedStatement(text) && !assertsSpecAsFact(text, claim)) {
      continue;
    }
    if (assertsSpecAsFact(text, claim) || draft.actionType === "FINISH") {
      return (
        `UNVERIFIED SPEC: navedena je neprovjerena referentna vrijednost "${claim.valueText}" (${claim.label}). ` +
        'Reci: "Točan referentni raspon za ovo vozilo nije verificiran." ' +
        "Ne navodi izmišljen OEM raspon."
      );
    }
  }

  return null;
}

function assertsSpecAsFact(text: string, claim: TechnicalSpecClaim): boolean {
  const n = fold(text);
  const valueBits = fold(claim.valueText).slice(0, 24);
  if (!n.includes(valueBits.slice(0, Math.min(12, valueBits.length))) && !n.includes(String(claim.low))) {
    return isReferenceLanguage(n);
  }
  return /mora biti|trebalo bi|trebao bi|trebala bi|ocekivan|normalno|tipicno|oem|za ovo vozilo|na ovom|definitiv|dokaz|potvrd/.test(
    n,
  )   || looksLikeSpecTable(n);
}
