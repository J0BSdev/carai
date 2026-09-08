import type {
  DiagnosticCase,
  SpecVerificationStatus,
  TechnicalSpecClaim,
} from "./types";

export type { SpecVerificationStatus, TechnicalSpecClaim };

/** Verified specs may only come from an external/technical source mechanism (none yet). */
export function getVerifiedTechnicalSpecs(
  diagnosticCase: DiagnosticCase,
): TechnicalSpecClaim[] {
  return (diagnosticCase.verifiedTechnicalSpecs ?? []).filter(
    (s) => s.status === "VERIFIED",
  );
}

/**
 * Extract vehicle-specific REFERENCE claims (expected/OEM/typical ranges),
 * not user MEASURED_EVIDENCE.
 */
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
    const contextLower = context.toLowerCase();
    const beforeLower = before.toLowerCase();

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

    const condition = detectCondition(beforeLower);
    const subject = detectSubject(
      `${contextLower} ${normalized.toLowerCase().slice(0, 200)}`,
    );
    const parameterKey = [
      unitFamily(unit),
      subject,
      condition ?? "nominal",
    ].join(":");

    claims.push({
      parameterKey,
      label: `${subject}${condition ? ` (${condition})` : ""}`,
      valueText,
      unit,
      low,
      high,
      condition,
      status: "UNVERIFIED",
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
    /izmjeren|izmjereno|izmjerili|ocitano|ocitano|rezultat\s*:|measured|reading\s*:|dobiveno|dobili smo|korisnik/.test(
      contextLower,
    ) && !/ocekivan|trebalo|normalno|tipicno|oem|spec/.test(contextLower)
  );
}

function isReferenceLanguage(contextLower: string): boolean {
  return /ocekivan|trebalo bi|treba biti|mora biti|normalno|tipicno|tipično|oem|specifikac|referent|raspon|range|prazan|pun\b|empty|full|približn|priblizn|~|za ovo vozilo|na ovom vozilu|factory|datasheet/.test(
    contextLower,
  );
}

function looksLikeSpecTable(contextLower: string): boolean {
  return /prazan|pun\b|empty|full|min\b|max\b|raspon|referent|ocekivan|normalno|tipicno|tipično/.test(
    contextLower,
  );
}

function detectCondition(beforeLower: string): string | null {
  const patterns: Array<{ cond: string; re: RegExp }> = [
    { cond: "empty", re: /prazan|prazno|\bempty\b|\bmin\b|0\s*%/gi },
    { cond: "full", re: /\bpun\b|punog|\bfull\b|\bmax\b|100\s*%/gi },
    { cond: "cold", re: /\bhladn|\bcold\b/gi },
    { cond: "hot", re: /\btopl|\bhot\b|radn(?:oj|a|i)?\s+temp/gi },
  ];

  let best: { cond: string; idx: number } | null = null;
  for (const { cond, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(beforeLower)) !== null) {
      if (!best || m.index >= best.idx) {
        best = { cond, idx: m.index };
      }
    }
  }
  return best?.cond ?? null;
}

function detectSubject(contextLower: string): string {
  if (/davac|davač|sender|plovak|fuel\s*level|razine goriva|nivo.*goriv/.test(contextLower)) {
    return "fuel_sender";
  }
  if (/instrument|kazaljk|pokazivac|cluster|mjera[cč]/.test(contextLower)) {
    return "gauge_cluster";
  }
  if (/senzor|sensor/.test(contextLower)) return "sensor";
  if (/pump/.test(contextLower)) return "pump";
  if (/osigurac|fuse/.test(contextLower)) return "fuse";
  if (/konektor|connector|pin/.test(contextLower)) return "connector";
  return "component";
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
  const n = text.toLowerCase();
  return (
    /nije verificiran|nije potvrden|nije potvrđen|unverified|specstatus\s*=\s*unverified|tocan referentni raspon.*nije|točan referentni raspon.*nije|nemam verificiran|bez verificiran/.test(
      n,
    )
  );
}

function claimCoveredByVerified(
  claim: TechnicalSpecClaim,
  verified: TechnicalSpecClaim[],
): boolean {
  return verified.some(
    (v) =>
      v.status === "VERIFIED" &&
      v.parameterKey === claim.parameterKey &&
      !rangesConflict(v, claim),
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

function claimsAreSameParameter(
  a: TechnicalSpecClaim,
  b: TechnicalSpecClaim,
): boolean {
  if (a.parameterKey === b.parameterKey) return true;
  const [familyA, subjectA, condA] = a.parameterKey.split(":");
  const [familyB, subjectB, condB] = b.parameterKey.split(":");
  if (familyA !== familyB || condA !== condB) return false;
  if (subjectA === subjectB) return true;
  // "component" is a weak subject — still align when unit+condition match
  return subjectA === "component" || subjectB === "component";
}

/** Collect reference claims already present in case history (locked for consistency). */
export function collectHistoricalReferenceClaims(
  diagnosticCase: DiagnosticCase,
): TechnicalSpecClaim[] {
  const fromField = diagnosticCase.technicalSpecClaims ?? [];
  const fromSteps: TechnicalSpecClaim[] = [];
  for (const step of diagnosticCase.steps) {
    const blob = [
      step.content,
      step.rationale,
      step.expectedResultHint,
      step.confirmedFault,
      ...(step.facts ?? []),
      ...(step.evidence ?? []),
    ]
      .filter(Boolean)
      .join("\n");
    fromSteps.push(...extractReferenceSpecClaims(blob));
  }
  return dedupeClaims([...fromField, ...fromSteps]);
}

function draftBlob(draft: {
  content?: string;
  rationale?: string;
  expectedResultHint?: string | null;
  confirmedFault?: string | null;
  facts?: string[] | null;
  evidence?: string[] | null;
}): string {
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
    insufficientEvidence?: boolean | null;
    confidence?: string | null;
  },
): string | null {
  const text = draftBlob(draft);
  if (!text.trim()) return null;

  const verified = getVerifiedTechnicalSpecs(diagnosticCase);
  const historical = collectHistoricalReferenceClaims(diagnosticCase);
  const newClaims = extractReferenceSpecClaims(text);

  // Consistency: contradicting a previously stated claim for same parameter
  for (const neu of newClaims) {
    const prev = historical.find((h) => claimsAreSameParameter(h, neu));
    if (prev && rangesConflict(prev, neu)) {
      return (
        `CONSISTENCY: kontradiktorna referentna specifikacija za ${neu.parameterKey}. ` +
        `PREVIOUS: ${prev.valueText}; NEW: ${neu.valueText}. ` +
        "Ne smiješ mijenjati tehničke referentne vrijednosti unutar istog slučaja. " +
        "Ako raspon nije u verifiedTechnicalSpecs, nemoj ga uopće navoditi kao činjenicu."
      );
    }
  }

  // Invented reference specs (not verified, not explicitly disclaimed)
  for (const claim of newClaims) {
    if (claimCoveredByVerified(claim, verified)) continue;

    // Allow sentences that only say the spec is unknown — but not if they also assert a concrete range as fact
    if (isExplicitlyUnverifiedStatement(text) && !assertsSpecAsFact(text, claim)) {
      continue;
    }

    if (assertsSpecAsFact(text, claim) || draft.actionType === "FINISH") {
      return (
        `UNVERIFIED SPEC: navedena je neprovjerena vehicle-specific referentna vrijednost "${claim.valueText}" (${claim.label}). ` +
        "specStatus=UNVERIFIED. AI se ne smije sam verificirati. " +
        'Reci: "Točan referentni raspon za ovo vozilo nije verificiran." ' +
        "Koristi kvalitativni test (npr. kontinuirana promjena signala kroz hod) umjesto izmišljenog OEM raspona. " +
        "UNVERIFIED SPEC nije dokaz."
      );
    }
  }

  // FINISH guard: measured vs expected without verified spec
  if (draft.actionType === "FINISH") {
    const finishIssue = findFinishUnverifiedSpecIssue(text, verified, newClaims);
    if (finishIssue) return finishIssue;
  }

  return null;
}

function assertsSpecAsFact(text: string, claim: TechnicalSpecClaim): boolean {
  const n = text.toLowerCase();
  const valueBits = claim.valueText.toLowerCase().slice(0, 24);
  if (!n.includes(valueBits.slice(0, Math.min(12, valueBits.length))) && !n.includes(String(claim.low))) {
    return isReferenceLanguage(n);
  }
  return /mora biti|trebalo bi|ocekivan|normalno|tipicno|tipično|oem|za ovo vozilo|na ovom|definitiv|dokaz|potvrd/.test(
    n,
  ) || looksLikeSpecTable(n);
}

function findFinishUnverifiedSpecIssue(
  text: string,
  verified: TechnicalSpecClaim[],
  claimsInDraft: TechnicalSpecClaim[],
): string | null {
  const n = text.toLowerCase();
  const requiresExactSpec =
    /(trebalo bi biti|mora biti|ocekivan|očekivan|normalno (je|bi)|tipicno|tipično|oem|referentni|umjesto \d|a trebalo|specifikac|raspon.*Ω|raspon.*ohm)/i.test(
      text,
    ) || claimsInDraft.length > 0;

  if (!requiresExactSpec) return null;

  const hasVerified = verified.length > 0 && claimsInDraft.some((c) => claimCoveredByVerified(c, verified));

  if (hasVerified) return null;

  // Confirmed diagnosis hinging on unverified Y
  const claimsConfirmed =
    /potvrd|confirmed|definitiv|nedvosmislen|dokaz.*Ω|Ω.*dokaz|zna[cč]i kvar/i.test(
      text,
    ) && !/likely|needs confirmation|nedostaje potvrda|insufficient|nije verificiran/i.test(n);

  if (claimsInDraft.length > 0 || claimsConfirmed) {
    return (
      "FINISH GUARD: requiresExactSpec===true ali verifiedSpec===false. " +
      "Ne smiješ potvrditi dijagnozu usporedbom measuredValue vs expectedSpecification bez VERIFIED specifikacije. " +
      "Vrati FINISH s insufficientEvidence=true kao LIKELY / NEEDS CONFIRMATION bez izmišljenih brojeva, " +
      "ILI nastavi TEST metodom koja ne zahtijeva nepoznatu OEM specifikaciju."
    );
  }

  return null;
}

/** Merge newly stated claims into case lock list (always UNVERIFIED unless already verified). */
export function mergeTechnicalSpecClaims(
  diagnosticCase: DiagnosticCase,
  draftText: string,
): TechnicalSpecClaim[] {
  const verified = getVerifiedTechnicalSpecs(diagnosticCase);
  const existing = collectHistoricalReferenceClaims(diagnosticCase);
  const extracted = extractReferenceSpecClaims(draftText).map((c) => {
    const match = verified.find((v) => v.parameterKey === c.parameterKey);
    if (match) return { ...match };
    return { ...c, status: "UNVERIFIED" as const };
  });
  return dedupeClaims([...existing, ...extracted]);
}
