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

type PriorCaseSearchInput = {
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

/** Tokens for symptom/problem overlap. Vehicle fields are dropped separately. */
function tokens(text: string, drop: Iterable<string> = []): Set<string> {
  const dropSet = new Set<string>();
  for (const d of drop) {
    for (const t of norm(d).split(/[^a-z0-9čćžšđüöä]+/i)) {
      if (t.length >= 4) dropSet.add(t);
    }
  }
  const out = new Set<string>();
  for (const t of norm(text).split(/[^a-z0-9čćžšđüöä]+/i)) {
    if (t.length >= 4 && !dropSet.has(t)) out.add(t);
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

function fieldMatch(
  query: string,
  row: string,
): "exact" | "partial" | "mismatch" | "none" {
  if (!query) return "none";
  if (!row) return "none";
  if (row === query) return "exact";
  if (row.includes(query) || query.includes(row)) return "partial";
  return "mismatch";
}

/**
 * Vehicle fields only affect rank. Inclusion needs a technical signal:
 * shared DTC, or token overlap on problem/symptoms (stricter alone than with model/engine).
 * Make alone never qualifies.
 */
function scoreRow(
  row: PriorCaseRow,
  query: PriorCaseSearchInput,
): { row: PriorCaseRow; score: number } | null {
  const qMake = norm(query.vehicle?.make);
  const qModel = norm(query.vehicle?.model);
  const qEngine = norm(query.vehicle?.engine);
  const rMake = norm(row.vehicle_make);
  const rModel = norm(row.vehicle_model);
  const rEngine = norm(row.vehicle_engine);

  const make = fieldMatch(qMake, rMake);
  const model = fieldMatch(qModel, rModel);
  const engine = fieldMatch(qEngine, rEngine);
  const modelOrEngine =
    model === "exact" ||
    model === "partial" ||
    engine === "exact" ||
    engine === "partial";

  let score = 0;
  if (make === "exact") score += 3;
  else if (make === "partial") score += 1;
  else if (make === "mismatch") score -= 2;
  if (model === "exact") score += 3;
  else if (model === "partial") score += 1;
  if (engine === "exact") score += 2;
  else if (engine === "partial") score += 1;
  if (
    query.vehicle?.year != null &&
    row.vehicle_year === query.vehicle.year
  ) {
    score += 1;
  }

  const vehicleDrop = [
    query.vehicle?.make,
    query.vehicle?.model,
    query.vehicle?.engine,
    row.vehicle_make,
    row.vehicle_model,
    row.vehicle_engine,
  ].filter(Boolean) as string[];

  const qTokens = tokens(
    [query.problemText, ...(query.symptoms ?? []), ...(query.dtcs ?? [])].join(
      " ",
    ),
    vehicleDrop,
  );
  const rTokens = tokens(
    [row.problem_text, row.confirmed_fault].join(" "),
    vehicleDrop,
  );

  let overlap = 0;
  for (const t of rTokens) {
    if (qTokens.has(t)) overlap += 1;
  }

  const queryDtcs = new Set(
    extractDtcCodes(query.problemText, ...(query.dtcs ?? [])),
  );
  const rowDtcs = new Set(
    extractDtcCodes(row.problem_text, row.confirmed_fault),
  );
  let dtcHits = 0;
  for (const code of queryDtcs) {
    if (rowDtcs.has(code)) dtcHits += 1;
  }

  const technical =
    dtcHits > 0 ||
    overlap >= 2 ||
    (overlap >= 1 && modelOrEngine);

  if (!technical) return null;

  score += overlap + dtcHits * 3;
  return { row, score };
}

function toHint(row: PriorCaseRow): PriorResolvedCaseHint {
  return {
    vehicle: vehicleLabel(row),
    problem: row.problem_text
      ? truncate(row.problem_text, PROBLEM_SNIPPET)
      : null,
    resolvedFault: row.confirmed_fault?.trim() || null,
    source: row.source === "manual" ? "manual" : "carai",
    certainty:
      row.source === "manual"
        ? "manual"
        : row.diagnosis_certainty ?? "unknown",
  };
}

type UserSupabase = NonNullable<Awaited<ReturnType<typeof createClient>>>;

async function searchPriorResolvedCases(
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
  if (make && make.length >= 2) {
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
          return [`problem_text.ilike.${p}`, `confirmed_fault.ilike.${p}`];
        })
        .join(",");
      builder = builder.or(dtcOr);
    } else {
      const sig = [...tokens(query.problemText)].slice(0, 6);
      if (sig.length === 0) return [];
      const tokenOr = sig
        .map((t) => `problem_text.ilike.${ilikeContains(t)}`)
        .join(",");
      builder = builder.or(tokenOr);
    }
  }

  const { data, error } = await builder.limit(FETCH_CAP);
  if (error || !data?.length) return [];

  return (data as PriorCaseRow[])
    .map((row) => scoreRow(row, query))
    .filter((item): item is { row: PriorCaseRow; score: number } => item != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N)
    .map((item) => toHint(item.row));
}

function priorSearchFingerprint(diagnosticCase: DiagnosticCase): string {
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
    const key = `${user.id}:${clean.id}`;
    const cached = priorHintsCache.get(key);
    if (cached?.fingerprint === fingerprint) {
      return {
        ...clean,
        priorResolvedHints: { fingerprint, items: cached.items },
      };
    }

    const items = await searchPriorResolvedCases(supabase, {
      excludeCaseId: clean.id,
      problemText: clean.problemText,
      vehicle: clean.extracted?.vehicle,
      symptoms: clean.extracted?.symptoms,
      dtcs: clean.extracted?.dtcs,
    });

    rememberCache(key, { fingerprint, items });
    return {
      ...clean,
      priorResolvedHints: { fingerprint, items },
    };
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
