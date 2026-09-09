import type { DiagnosticCase, DiagnosticStep } from "./types";

export type ReasoningDraft = {
  actionType?: string;
  content?: string;
  rationale?: string;
  expectedResultHint?: string | null;
  confirmedFault?: string | null;
  facts?: string[] | null;
  evidence?: string[] | null;
  hypotheses?: Array<{
    label?: string | null;
    cause?: string | null;
    status?: string | null;
    note?: string | null;
  }> | null;
};

type Polarity = "positive" | "negative";

type AtomicClaim = {
  subjectKey: string;
  polarity: Polarity;
  raw: string;
  /** Lower = earlier in text / case. */
  order: number;
  stepIndex: number | null;
  stepId: string | null;
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9čćžšđ\s=+\-_/]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function draftBlob(draft: ReasoningDraft): string {
  return [
    draft.content,
    draft.rationale,
    draft.expectedResultHint,
    draft.confirmedFault,
    ...(draft.facts ?? []),
    ...(draft.evidence ?? []),
    ...(draft.hypotheses ?? []).flatMap((h) => [
      h.label,
      h.cause,
      h.status,
      h.note,
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

function stepBlob(step: DiagnosticStep): string {
  return [
    step.content,
    step.rationale,
    step.expectedResultHint,
    step.confirmedFault,
    ...(step.facts ?? []),
    ...(step.evidence ?? []),
    ...(step.hypotheses ?? []).flatMap((h) => [
      h.label,
      h.status,
      h.note,
      ...(h.supportingEvidence ?? []),
      ...(h.contradictingEvidence ?? []),
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

const SUBJECT_ALIASES: Array<{ key: string; patterns: RegExp[] }> = [
  { key: "power", patterns: [/\b(napajanje|power|b\+|plus|12\s*v napaj)\b/] },
  { key: "ground", patterns: [/\b(masa|ground|gnd|uzemljen)\b/] },
  {
    key: "signal",
    patterns: [/\b(signal|signala|signalni|signalnog)\b/],
  },
  {
    key: "reference",
    patterns: [/\b(referenc|5\s*v ref|vref)\b/],
  },
  {
    key: "continuity",
    patterns: [/\b(kontinuitet|continuity|otvoren krug|open circuit)\b/],
  },
  {
    key: "short_to_ground",
    patterns: [/\b(kratki.*mas|short to ground|kratki spoj.*mas)\b/],
  },
  {
    key: "short_to_power",
    patterns: [/\b(kratki.*plus|short to power|kratki spoj.*napaj)\b/],
  },
];

const POSITIVE_RE =
  /\b(ok|u redu|ispravan|ispravno|prisutan|prisutno|present|good|pass|prolazi|kontinuiran|continuous|zatvoren krug|confirmed|potvrden|potvrđeno|potvrdeno|dokazan|ima|dostupan|normalan|normalno)\b/;
const NEGATIVE_RE =
  /\b(missing|nedostaje|odsutan|odsutno|nema|fail|failed|neispravan|neispravno|kvar|prekinut|open|otvoren|loose|loose connection|ruled.?out|iskljucen|isključen|negativ|lo[sš]|bad|absent|prekida|prekid)\b/;

function detectSubject(window: string): string | null {
  for (const alias of SUBJECT_ALIASES) {
    if (alias.patterns.some((p) => p.test(window))) return alias.key;
  }
  // Generic "X = OK/MISSING" subject token
  const eq = window.match(
    /\b([a-zčćžšđ][a-zčćžšđ0-9_/]{2,24})\s*(?:=|jest|je)\s*(ok|missing|nedostaje|neispravan|ispravan|fail|failed|prisutan|odsutan)/,
  );
  if (eq?.[1]) return normalizeSubjectToken(eq[1]);
  return null;
}

function normalizeSubjectToken(token: string): string {
  const t = normalize(token);
  for (const alias of SUBJECT_ALIASES) {
    if (alias.patterns.some((p) => p.test(t))) return alias.key;
  }
  return t.slice(0, 32);
}

function polarityFromWindow(window: string): Polarity | null {
  const pos = POSITIVE_RE.test(window);
  const neg = NEGATIVE_RE.test(window);
  if (pos && !neg) return "positive";
  if (neg && !pos) return "negative";
  // Explicit assignment wins when both present nearby
  if (/\b(missing|nedostaje|fail|neispravan|prekinut|odsutan)\b/.test(window)) {
    return "negative";
  }
  if (/\b(ok|ispravan|prisutan|potvrden|confirmed)\b/.test(window)) {
    return "positive";
  }
  if (pos && neg) return null;
  return null;
}

/** Extract subject↔polarity claims from free text. */
export function extractPolarityClaims(
  text: string,
  baseOrder: number,
  stepIndex: number | null,
  stepId: string | null,
): AtomicClaim[] {
  const n = normalize(text);
  if (!n) return [];
  const claims: AtomicClaim[] = [];

  // Pattern: subject = polarity / subject polarity
  const assignRe =
    /\b([a-zčćžšđ][a-zčćžšđ0-9_/ ]{1,40}?)\s*(?:=|:|jest|je|=)\s*(ok|u redu|ispravan|prisutan|missing|nedostaje|neispravan|fail|failed|odsutan|prekinut|open|kvar)\b/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(n)) !== null) {
    const subject = normalizeSubjectToken(m[1]);
    const pol = polarityFromWindow(m[2]);
    if (!subject || !pol) continue;
    claims.push({
      subjectKey: subject,
      polarity: pol,
      raw: m[0],
      order: baseOrder + m.index,
      stepIndex,
      stepId,
    });
  }

  // Windowed subject mentions with nearby polarity words
  for (const alias of SUBJECT_ALIASES) {
    for (const pat of alias.patterns) {
      const re = new RegExp(pat.source, "gi");
      let hit: RegExpExecArray | null;
      while ((hit = re.exec(n)) !== null) {
        const start = Math.max(0, hit.index - 28);
        const end = Math.min(n.length, hit.index + hit[0].length + 36);
        const window = n.slice(start, end);
        const pol = polarityFromWindow(window);
        if (!pol) continue;
        claims.push({
          subjectKey: alias.key,
          polarity: pol,
          raw: window.trim(),
          order: baseOrder + hit.index,
          stepIndex,
          stepId,
        });
      }
    }
  }

  // Hypothesis status flips
  const hypRe =
    /\b(.{3,60}?)\s*(ruled.?out|iskljucen|isključen|eliminiran|potvrden|potvrđen|likely|possible|weak)\b/gi;
  while ((m = hypRe.exec(text)) !== null) {
    const subject = `hyp:${normalize(m[1]).slice(0, 40)}`;
    const status = normalize(m[2]);
    const polarity: Polarity =
      /ruled|iskljuc|elimin/.test(status) ? "negative" : "positive";
    claims.push({
      subjectKey: subject,
      polarity,
      raw: m[0],
      order: baseOrder + m.index,
      stepIndex,
      stepId,
    });
  }

  return dedupeClaims(claims);
}

function dedupeClaims(claims: AtomicClaim[]): AtomicClaim[] {
  const out: AtomicClaim[] = [];
  for (const c of claims) {
    const prev = out.find(
      (x) =>
        x.subjectKey === c.subjectKey &&
        x.polarity === c.polarity &&
        Math.abs(x.order - c.order) < 12,
    );
    if (prev) continue;
    out.push(c);
  }
  return out;
}

function opposite(a: Polarity, b: Polarity): boolean {
  return a !== b;
}

function isRealEvidenceResult(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  return !(
    n.includes("ne mogu izvesti") ||
    n.includes("preskoc") ||
    /\bskipped\b/.test(n) ||
    /\bunavailable\b/.test(n) ||
    n.includes("nije dostupan") ||
    n.includes("cant perform") ||
    n.includes("cannot perform")
  );
}

function hasNewEvidenceAfterStep(
  diagnosticCase: DiagnosticCase,
  stepIndex: number,
  subjectKey: string,
): boolean {
  const stepIds = new Set(
    diagnosticCase.steps.slice(stepIndex).map((s) => s.id),
  );
  const relevant = diagnosticCase.observations.filter(
    (o) => stepIds.has(o.stepId) && isRealEvidenceResult(o.resultText),
  );
  if (relevant.length === 0) return false;

  // Hypothesis flips may follow any real new evidence.
  if (subjectKey.startsWith("hyp:")) return true;

  const alias = SUBJECT_ALIASES.find((a) => a.key === subjectKey);
  const patterns =
    alias?.patterns ?? [new RegExp(subjectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")];

  // Prefer subject-linked evidence; also allow clear measurement results as new proof.
  return relevant.some((o) => {
    const n = normalize(o.resultText);
    if (patterns.some((p) => p.test(n))) return true;
    return /\d/.test(n) && /(v|ohm|Ω|bar|ok|missing|fail|napon|otpor|signal|masa|napaj)/.test(n);
  });
}

function findContradiction(
  earlier: AtomicClaim,
  later: AtomicClaim,
): boolean {
  if (earlier.subjectKey !== later.subjectKey) return false;
  if (!opposite(earlier.polarity, later.polarity)) return false;
  return later.order > earlier.order;
}

/**
 * HARD FAIL: later claim must not contradict earlier reasoning without new evidence.
 * Also fails internal draft contradictions (same response, no new evidence possible).
 */
export function findReasoningConsistencyIssue(
  diagnosticCase: DiagnosticCase,
  draft: ReasoningDraft,
): string | null {
  const content = draft.content ?? "";
  const rest = [
    draft.rationale,
    draft.expectedResultHint,
    draft.confirmedFault,
    ...(draft.facts ?? []),
    ...(draft.evidence ?? []),
  ]
    .filter(Boolean)
    .join("\n");

  const earlyDraft = extractPolarityClaims(content, 0, null, null);
  const lateDraft = extractPolarityClaims(rest, 10_000, null, null);
  const allDraft = [
    ...earlyDraft,
    ...lateDraft,
    ...extractPolarityClaims(draftBlob(draft), 0, null, null),
  ];

  // 1) Within same draft: any opposite polarity on same subject → FAIL
  for (let i = 0; i < allDraft.length; i++) {
    for (let j = i + 1; j < allDraft.length; j++) {
      const a = allDraft[i]!;
      const b = allDraft[j]!;
      if (a.subjectKey !== b.subjectKey) continue;
      if (!opposite(a.polarity, b.polarity)) continue;
      const earlier = a.order <= b.order ? a : b;
      const later = a.order <= b.order ? b : a;
      return (
        `REASONING CONTRADICTION: kasnija tvrdnja ("${later.raw}") proturječi ranijem dijelu istog odgovora ("${earlier.raw}") ` +
        `za "${earlier.subjectKey}" bez novog dokaza. ` +
        "FAIL — regeneriraj konzistentan reasoning."
      );
    }
  }

  // Explicit early content vs later rationale (order-enforced)
  for (const early of earlyDraft) {
    for (const late of lateDraft) {
      if (!findContradiction(early, late)) continue;
      return (
        `REASONING CONTRADICTION: rationale/zaključak ("${late.raw}") proturječi ranijem contentu ("${early.raw}") ` +
        `za "${early.subjectKey}" bez novog dokaza. FAIL — regeneriraj.`
      );
    }
  }

  // 2) Cross-case: contradict prior AI steps without new evidence after that step
  const priorClaims: AtomicClaim[] = [];
  diagnosticCase.steps.forEach((step, idx) => {
    priorClaims.push(
      ...extractPolarityClaims(stepBlob(step), idx * 1000, idx, step.id),
    );
  });

  for (const prior of priorClaims) {
    if (prior.stepIndex == null) continue;
    const allowed = hasNewEvidenceAfterStep(
      diagnosticCase,
      prior.stepIndex,
      prior.subjectKey,
    );
    if (allowed) continue;

    for (const neu of allDraft) {
      if (prior.subjectKey !== neu.subjectKey) continue;
      if (!opposite(prior.polarity, neu.polarity)) continue;
      return (
        `REASONING CONTRADICTION: nova tvrdnja ("${neu.raw}") proturječi ranijem AI reasoningu ` +
        `("${prior.raw}") za "${prior.subjectKey}" bez novog dokaza u CASE STATE. ` +
        "FAIL — regeneriraj; ne mijenjaj zaključak bez novog test rezultata."
      );
    }
  }

  return null;
}
