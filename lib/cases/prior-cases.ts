import { createClient } from "@/lib/supabase/server";
import type {
  DiagnosticCase,
  PriorResolvedCaseHint,
  PriorResolvedHints,
  VehicleInfo,
} from "@/lib/diagnosis/types";

/** Safety cap after SQL filters — not "newest N before rank". */
const FETCH_CAP = 500;
const TOP_N = 5;
const MIN_SCORE = 12;
const PROBLEM_SNIPPET = 120;
const CACHE_MAX_ENTRIES = 200;

type PriorCaseRow = {
  id: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: number | null;
  vehicle_engine: string | null;
  problem_text: string | null;
  confirmed_fault: string | null;
  source: string;
  diagnosis_certainty: string | null;
};

export type PriorCaseSearchInput = {
  excludeCaseId: string;
  problemText: string;
  vehicle?: VehicleInfo;
  symptoms?: string[];
  dtcs?: string[];
};

/** Server-only cache. Never trust client-sent priorResolvedHints. */
type CacheEntry = {
  fingerprint: string;
  items: PriorResolvedCaseHint[];
};

const priorHintsCache = new Map<string, CacheEntry>();

function cacheKey(userId: string, caseId: string): string {
  return `${userId}:${caseId}`;
}

function rememberCache(key: string, entry: CacheEntry): void {
  if (priorHintsCache.size >= CACHE_MAX_ENTRIES && !priorHintsCache.has(key)) {
    const oldest = priorHintsCache.keys().next().value;
    if (oldest != null) priorHintsCache.delete(oldest);
  }
  priorHintsCache.set(key, entry);
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Weak fillers — not enough alone for technical relevance. */
const STOP_TOKENS = new Set([
  "auto",
  "vozilo",
  "motor",
  "problem",
  "kvar",
  "greška",
  "greska",
  "fault",
  "error",
  "code",
  "kod",
  "kodovi",
  "lampica",
  "check",
  "engine",
  "light",
  "nešto",
  "nesto",
  "radi",
  "ima",
  "the",
  "and",
  "ili",
  "kad",
  "kada",
  "while",
  "with",
  "from",
]);

function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9čćžšđüöä]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4);
}

function technicalTokens(text: string, drop: Iterable<string> = []): Set<string> {
  const dropSet = new Set<string>();
  for (const d of drop) {
    for (const t of rawTokens(d)) dropSet.add(t);
  }
  const out = new Set<string>();
  for (const t of rawTokens(text)) {
    if (STOP_TOKENS.has(t) || dropSet.has(t)) continue;
    out.add(t);
  }
  return out;
}

function extractDtcCodes(...parts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const m of part.toUpperCase().matchAll(/\b[PCBU][0-9A-F]{4}\b/g)) {
      found.add(m[0]);
    }
  }
  for (const part of parts) {
    if (!part) continue;
    const trimmed = part.trim().toUpperCase();
    if (/^[PCBU][0-9A-F]{4}$/.test(trimmed)) found.add(trimmed);
  }
  return [...found];
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function vehicleLabel(row: PriorCaseRow): string | null {
  const parts = [
    row.vehicle_make,
    row.vehicle_model,
    row.vehicle_year != null ? String(row.vehicle_year) : null,
    row.vehicle_engine,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length ? parts.join(" ") : null;
}

function escapeIlike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function ilikeContains(value: string): string {
  return `%${escapeIlike(value)}%`;
}

function partialMatch(a: string, b: string): boolean {
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

type ScoredRow = {
  row: PriorCaseRow;
  score: number;
  include: boolean;
};

/**
 * Vehicle match only boosts rank. Inclusion requires a technical signal:
 * DTC overlap, or meaningful symptom/problem token overlap (optionally with model/engine).
 * Make alone is never enough.
 */
function scoreRow(row: PriorCaseRow, query: PriorCaseSearchInput): ScoredRow {
  const qMake = norm(query.vehicle?.make);
  const qModel = norm(query.vehicle?.model);
  const qEngine = norm(query.vehicle?.engine);
  const qYear = query.vehicle?.year;
  const rMake = norm(row.vehicle_make);
  const rModel = norm(row.vehicle_model);
  const rEngine = norm(row.vehicle_engine);

  let vehicleScore = 0;
  let modelMatch = false;
  let engineMatch = false;

  if (qMake) {
    if (rMake === qMake) {
      vehicleScore += 25;
    } else if (partialMatch(rMake, qMake)) {
      vehicleScore += 12;
    } else if (rMake) {
      vehicleScore -= 20;
    }
  }

  if (qModel) {
    if (rModel === qModel) {
      vehicleScore += 20;
      modelMatch = true;
    } else if (partialMatch(rModel, qModel)) {
      vehicleScore += 10;
      modelMatch = true;
    }
  }

  if (qEngine) {
    if (rEngine === qEngine) {
      vehicleScore += 12;
      engineMatch = true;
    } else if (partialMatch(rEngine, qEngine)) {
      vehicleScore += 6;
      engineMatch = true;
    }
  }

  if (qYear != null && row.vehicle_year === qYear) vehicleScore += 4;

  const vehicleDrop = [
    query.vehicle?.make,
    query.vehicle?.model,
    query.vehicle?.engine,
    row.vehicle_make,
    row.vehicle_model,
    row.vehicle_engine,
  ].filter(Boolean) as string[];

  const queryTechText = [
    query.problemText,
    ...(query.symptoms ?? []),
    ...(query.dtcs ?? []),
  ].join(" ");
  const rowTechText = [row.problem_text, row.confirmed_fault].join(" ");

  const qTokens = technicalTokens(queryTechText, vehicleDrop);
  const rTokens = technicalTokens(rowTechText, vehicleDrop);

  let overlap = 0;
  for (const t of rTokens) {
    if (qTokens.has(t)) overlap += 1;
  }

  const queryDtcs = new Set([
    ...extractDtcCodes(query.problemText, ...(query.dtcs ?? [])),
    ...(query.dtcs ?? []).map((d) => d.trim().toUpperCase()).filter(Boolean),
  ]);
  const rowDtcs = extractDtcCodes(row.problem_text, row.confirmed_fault);
  let dtcHits = 0;
  for (const code of queryDtcs) {
    if (code.length >= 5 && rowDtcs.includes(code)) dtcHits += 1;
    else if (
      code.length >= 5 &&
      rowTechText.toUpperCase().includes(code)
    ) {
      dtcHits += 1;
    }
  }

  const technical =
    dtcHits > 0 ||
    overlap >= 2 ||
    (overlap >= 1 && (modelMatch || engineMatch));

  if (!technical) {
    return { row, score: 0, include: false };
  }

  let score = vehicleScore + Math.min(30, overlap * 6) + dtcHits * 14;
  if (row.confirmed_fault?.trim()) score += 2;

  return {
    row,
    score,
    include: score >= MIN_SCORE,
  };
}

function toHint(row: PriorCaseRow): PriorResolvedCaseHint {
  const certainty =
    row.source === "manual"
      ? "manual"
      : row.diagnosis_certainty ?? "unknown";
  return {
    vehicle: vehicleLabel(row),
    problem: row.problem_text ? truncate(row.problem_text, PROBLEM_SNIPPET) : null,
    resolvedFault: row.confirmed_fault?.trim() || null,
    source: row.source === "manual" ? "manual" : "carai",
    certainty,
  };
}

/**
 * Search the signed-in user's resolved cases (manual + finished AI with
 * CONFIRMED/HIGH_CONFIDENCE). Uses the user Supabase client and RLS.
 * Never throws — empty on missing auth, Supabase, or errors.
 */
export async function searchPriorResolvedCases(
  query: PriorCaseSearchInput,
): Promise<PriorResolvedCaseHint[]> {
  try {
    const supabase = await createClient();
    if (!supabase) return [];

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    return searchPriorResolvedCasesWithClient(supabase, query);
  } catch {
    return [];
  }
}

type UserSupabase = NonNullable<Awaited<ReturnType<typeof createClient>>>;

async function searchPriorResolvedCasesWithClient(
  supabase: UserSupabase,
  query: PriorCaseSearchInput,
): Promise<PriorResolvedCaseHint[]> {
  let builder = supabase
    .from("diagnostic_cases")
    .select(
      "id, vehicle_make, vehicle_model, vehicle_year, vehicle_engine, problem_text, confirmed_fault, source, diagnosis_certainty",
    )
    .neq("id", query.excludeCaseId)
    .or(
      "source.eq.manual,diagnosis_certainty.eq.CONFIRMED,diagnosis_certainty.eq.HIGH_CONFIDENCE",
    );

  const make = query.vehicle?.make?.trim();
  const hasMake = Boolean(make && make.length >= 2);
  if (hasMake && make) {
    // All ages for this make; technical relevance is decided in-memory.
    builder = builder.ilike("vehicle_make", ilikeContains(make));
  } else {
    const dtcCodes = extractDtcCodes(
      query.problemText,
      ...(query.dtcs ?? []),
    ).slice(0, 8);
    if (dtcCodes.length > 0) {
      const dtcOr = dtcCodes
        .flatMap((code) => {
          const p = ilikeContains(code);
          return [
            `problem_text.ilike.${p}`,
            `confirmed_fault.ilike.${p}`,
          ];
        })
        .join(",");
      builder = builder.or(dtcOr);
    } else {
      const sig = [...technicalTokens(query.problemText)].slice(0, 6);
      if (sig.length === 0) return [];
      const tokenOr = sig
        .map((t) => `problem_text.ilike.${ilikeContains(t)}`)
        .join(",");
      builder = builder.or(tokenOr);
    }
  }

  // Filtered set (all ages). Cap only as safety — not "newest 80 then rank".
  const { data, error } = await builder.limit(FETCH_CAP);

  if (error || !data?.length) return [];

  return (data as PriorCaseRow[])
    .map((row) => scoreRow(row, query))
    .filter((item) => item.include)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N)
    .map((item) => toHint(item.row));
}

/** Stable key for vehicle / symptoms / DTCs / complaint — skip re-search when unchanged. */
export function priorSearchFingerprint(diagnosticCase: DiagnosticCase): string {
  const v = diagnosticCase.extracted?.vehicle;
  const symptoms = [...(diagnosticCase.extracted?.symptoms ?? [])]
    .map((s) => norm(s))
    .filter(Boolean)
    .sort();
  const dtcs = [...(diagnosticCase.extracted?.dtcs ?? [])]
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean)
    .sort();
  return [
    norm(diagnosticCase.problemText),
    norm(v?.make),
    norm(v?.model),
    v?.year != null ? String(v.year) : "",
    norm(v?.engine),
    symptoms.join(","),
    dtcs.join(","),
  ].join("|");
}

/**
 * Attach prior-case hints from a server-side search/cache.
 * Ignores any client-supplied priorResolvedHints (spoofing / cache poisoning).
 */
export async function attachPriorResolvedHints(
  diagnosticCase: DiagnosticCase,
): Promise<DiagnosticCase> {
  // Never reuse client-supplied hints (fingerprint/cache spoofing).
  const clean: DiagnosticCase = { ...diagnosticCase };
  delete clean.priorResolvedHints;

  try {
    const supabase = await createClient();
    if (!supabase) return clean;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return clean;

    const fingerprint = priorSearchFingerprint(clean);
    const key = cacheKey(user.id, clean.id);
    const cached = priorHintsCache.get(key);
    if (cached && cached.fingerprint === fingerprint) {
      const priorResolvedHints: PriorResolvedHints = {
        fingerprint,
        items: cached.items,
      };
      return { ...clean, priorResolvedHints };
    }

    const items = await searchPriorResolvedCasesWithClient(supabase, {
      excludeCaseId: clean.id,
      problemText: clean.problemText,
      vehicle: clean.extracted?.vehicle,
      symptoms: clean.extracted?.symptoms,
      dtcs: clean.extracted?.dtcs,
    });

    rememberCache(key, { fingerprint, items });
    const priorResolvedHints: PriorResolvedHints = { fingerprint, items };
    return { ...clean, priorResolvedHints };
  } catch {
    return clean;
  }
}

/** Compact lines for the diagnostic Claude prompt. Null when nothing to show. */
export function formatPriorResolvedHintsForPrompt(
  hints: PriorResolvedHints | undefined,
): string | null {
  const items = hints?.items;
  if (!items?.length) return null;
  const compact = items.map((item) => {
    const row: Record<string, string> = {};
    if (item.vehicle) row.vehicle = item.vehicle;
    if (item.problem) row.problem = item.problem;
    if (item.resolvedFault) row.resolvedFault = item.resolvedFault;
    row.source = item.source;
    row.certainty = item.certainty;
    return row;
  });
  return [
    "PRIOR_RESOLVED_CASES (samo mogući tragovi iz prošlih kvarova istog korisnika; nisu dokaz trenutačnog kvara; i dalje traži potvrdu ASK/TEST):",
    JSON.stringify(compact),
  ].join("\n");
}
