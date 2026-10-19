import { createClient } from "@/lib/supabase/server";
import type {
  DiagnosticCase,
  PriorResolvedCaseHint,
  PriorResolvedHints,
  VehicleInfo,
} from "@/lib/diagnosis/types";

/** Max short candidates sent to Claude (Claude judges relevance). */
const MAX_CANDIDATES = 8;
/** Pool fetched before vehicle preference trim (make-filtered or recent). */
const FETCH_POOL = 40;
const PROBLEM_SNIPPET = 100;
const FAULT_SNIPPET = 80;
const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;

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
  updated_at?: string;
};

type PriorCaseSearchInput = {
  excludeCaseId: string;
  problemText: string;
  vehicle?: VehicleInfo;
  dtcs?: string[];
};

type CacheEntry = {
  fingerprint: string;
  items: PriorResolvedCaseHint[];
  expiresAt: number;
};

const priorHintsCache = new Map<string, CacheEntry>();

function rememberCache(key: string, entry: CacheEntry): void {
  if (priorHintsCache.size >= CACHE_MAX_ENTRIES && !priorHintsCache.has(key)) {
    const oldest = priorHintsCache.keys().next().value;
    if (oldest != null) priorHintsCache.delete(oldest);
  }
  priorHintsCache.set(key, entry);
}

function cacheGet(key: string, fingerprint: string): PriorResolvedCaseHint[] | null {
  const cached = priorHintsCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    priorHintsCache.delete(key);
    return null;
  }
  if (cached.fingerprint !== fingerprint) return null;
  return cached.items;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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

function partialField(a: string, b: string): boolean {
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

/**
 * Prefer same model/engine when trimming the pool for token budget.
 * Not a technical-relevance judgment — Claude does that.
 */
function preferVehicleMatch(
  rows: PriorCaseRow[],
  query: PriorCaseSearchInput,
): PriorCaseRow[] {
  if (rows.length <= MAX_CANDIDATES) return rows;

  const qModel = norm(query.vehicle?.model);
  const qEngine = norm(query.vehicle?.engine);
  const modelHits: PriorCaseRow[] = [];
  const engineHits: PriorCaseRow[] = [];
  const rest: PriorCaseRow[] = [];

  for (const row of rows) {
    if (qModel && partialField(norm(row.vehicle_model), qModel)) {
      modelHits.push(row);
    } else if (qEngine && partialField(norm(row.vehicle_engine), qEngine)) {
      engineHits.push(row);
    } else {
      rest.push(row);
    }
  }

  return [...modelHits, ...engineHits, ...rest].slice(0, MAX_CANDIDATES);
}

function toHint(row: PriorCaseRow): PriorResolvedCaseHint | null {
  const priorEvidence =
    row.source === "manual" || row.diagnosis_certainty === "CONFIRMED"
      ? "technician_confirmed"
      : row.diagnosis_certainty === "HIGH_CONFIDENCE"
        ? "ai_high_confidence"
        : null;
  if (!priorEvidence) return null;

  return {
    vehicle: vehicleLabel(row),
    problem: row.problem_text
      ? truncate(row.problem_text, PROBLEM_SNIPPET)
      : null,
    resolvedFault: row.confirmed_fault
      ? truncate(row.confirmed_fault, FAULT_SNIPPET)
      : null,
    source: row.source === "manual" ? "manual" : "carai",
    priorEvidence,
  };
}

type UserSupabase = NonNullable<Awaited<ReturnType<typeof createClient>>>;

/**
 * Narrow candidate pool in SQL by vehicle / DTC only.
 * No symptom-token filters — synonyms must reach Claude.
 */
async function searchPriorResolvedCases(
  supabase: UserSupabase,
  query: PriorCaseSearchInput,
): Promise<PriorResolvedCaseHint[]> {
  let builder = supabase
    .from("diagnostic_cases")
    .select(
      "id, vehicle_make, vehicle_model, vehicle_year, vehicle_engine, problem_text, confirmed_fault, source, diagnosis_certainty, updated_at",
    )
    .neq("id", query.excludeCaseId)
    .or(
      "source.eq.manual,diagnosis_certainty.eq.CONFIRMED,diagnosis_certainty.eq.HIGH_CONFIDENCE",
    )
    .order("updated_at", { ascending: false })
    .limit(FETCH_POOL);

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
    }
    // No make and no DTC: recent resolved cases for this user (RLS). Claude filters.
  }

  const { data, error } = await builder;
  if (error || !data?.length) return [];

  const picked = preferVehicleMatch(data as PriorCaseRow[], query);
  const hints: PriorResolvedCaseHint[] = [];
  for (const row of picked) {
    const hint = toHint(row);
    if (hint) hints.push(hint);
  }
  return hints;
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
 * Attach prior-case candidates from a server-side search/cache.
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
    const cachedItems = cacheGet(key, fingerprint);
    if (cachedItems) {
      return {
        ...clean,
        priorResolvedHints: { fingerprint, items: cachedItems },
      };
    }

    const items = await searchPriorResolvedCases(supabase, {
      excludeCaseId: clean.id,
      problemText: clean.problemText,
      vehicle: clean.extracted?.vehicle,
      dtcs: clean.extracted?.dtcs,
    });

    rememberCache(key, {
      fingerprint,
      items,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return {
      ...clean,
      priorResolvedHints: { fingerprint, items },
    };
  } catch {
    return clean;
  }
}

/** Compact candidate list for the diagnostic Claude prompt. */
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
    row.priorEvidence = item.priorEvidence;
    return row;
  });
  return [
    "PRIOR_RESOLVED_CASE_CANDIDATES (backend shortlist iz prošlih kvarova istog korisnika. Ti procijeni tehničku relevantnost prema vozilu, motoru, simptomima, DTC i rezultatima OVOG slučaja. Smiješ zanemariti sve. Samo tragovi, nikad dokaz. Ne preskači potrebne TEST. Ne diži diagnosisCertainty zbog sličnog prošlog kvara. priorEvidence technician_confirmed ≠ ai_high_confidence.):",
    JSON.stringify(compact),
  ].join("\n");
}
