import { createClient } from "@/lib/supabase/server";
import type {
  DiagnosticCase,
  PriorResolvedCaseHint,
  PriorResolvedHints,
  VehicleInfo,
} from "@/lib/diagnosis/types";

const MAX_CANDIDATES = 8;
/** DTC rows fetched once, then ranked — high enough not to drop older priority hits per user. */
const DTC_FETCH_CAP = 1000;
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
  updated_at: string;
};

type PriorCaseSearchInput = {
  excludeCaseId: string;
  problemText: string;
  vehicle?: VehicleInfo;
  dtcs?: string[];
};

type SearchKeys = {
  make: string | null;
  model: string | null;
  engine: string | null;
  dtcs: string[];
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

function ilikeContains(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  return `%${escaped}%`;
}

/** Split engine labels into comparable tokens (handles "1.9TDI" vs "1.9 TDI"). */
function engineTokens(raw: string): string[] {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(\d+(?:\.\d+)?)/g, " $1 ")
    .replace(/([a-z]+)/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Exact = same normalized designation; partial = all tokens of the shorter
 * appear in the longer (same code, different spacing/order noise).
 * Avoids raw ILIKE false friends like "2.0" ⊂ "12.0".
 */
function matchEngine(
  query: string | null,
  rowVal: string | null,
): "exact" | "partial" | "none" {
  if (!query || !rowVal) return "none";
  const qt = engineTokens(query);
  const rt = engineTokens(rowVal);
  if (!qt.length || !rt.length) return "none";

  const qc = qt.join("");
  const rc = rt.join("");
  if (qc === rc) return "exact";
  if (
    qt.length === rt.length &&
    [...qt].sort().join("\0") === [...rt].sort().join("\0")
  ) {
    return "exact";
  }

  const [shorter, longer] = qt.length <= rt.length ? [qt, rt] : [rt, qt];
  if (shorter.join("").length < 3) return "none";
  if (!shorter.every((t) => longer.includes(t))) return "none";
  return "partial";
}

function modelsMatch(query: string | null, rowVal: string | null): boolean {
  if (!query || !rowVal) return false;
  const a = norm(query);
  const b = norm(rowVal);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Null when there is no DTC / model / engine to search on. */
function searchableKeys(query: PriorCaseSearchInput): SearchKeys | null {
  const make = query.vehicle?.make?.trim() || null;
  const model = query.vehicle?.model?.trim() || null;
  const engine = query.vehicle?.engine?.trim() || null;
  const dtcs = extractDtcCodes(
    query.problemText,
    ...(query.dtcs ?? []),
  ).slice(0, 8);

  const modelKey = model && model.length >= 2 ? model : null;
  const engineKey = engine && engine.length >= 2 ? engine : null;
  if (!modelKey && !engineKey && dtcs.length === 0) return null;

  return {
    make: make && make.length >= 2 ? make : null,
    model: modelKey,
    engine: engineKey,
    dtcs,
  };
}

function toHint(row: PriorCaseRow): PriorResolvedCaseHint {
  const source = row.source === "manual" ? "manual" : "carai";
  return {
    vehicle: vehicleLabel(row),
    problem: row.problem_text
      ? truncate(row.problem_text, PROBLEM_SNIPPET)
      : null,
    resolvedFault: row.confirmed_fault
      ? truncate(row.confirmed_fault, FAULT_SNIPPET)
      : null,
    source,
    diagnosisCertainty: source === "manual" ? null : row.diagnosis_certainty,
  };
}

type UserSupabase = NonNullable<Awaited<ReturnType<typeof createClient>>>;

async function fetchMatchingRows(
  supabase: UserSupabase,
  excludeCaseId: string,
  make: string | null,
  orFilter: string,
  limit: number,
): Promise<PriorCaseRow[]> {
  let builder = supabase
    .from("diagnostic_cases")
    .select(
      "id, vehicle_make, vehicle_model, vehicle_year, vehicle_engine, problem_text, confirmed_fault, source, diagnosis_certainty, updated_at",
    )
    .neq("id", excludeCaseId)
    .or(
      "source.eq.manual,diagnosis_certainty.eq.CONFIRMED,diagnosis_certainty.eq.HIGH_CONFIDENCE",
    );
  if (make) {
    builder = builder.ilike("vehicle_make", ilikeContains(make));
  }
  const { data, error } = await builder
    .or(orFilter)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[prior-cases] query failed", error.message);
    return [];
  }
  if (!data?.length) return [];
  return data as PriorCaseRow[];
}

function compareStable(a: PriorCaseRow, b: PriorCaseRow): number {
  const byDate = b.updated_at.localeCompare(a.updated_at);
  if (byDate !== 0) return byDate;
  return b.id.localeCompare(a.id);
}

/** Priority 1–4 for DTC rows; lower number = higher priority. */
function dtcRowPriority(row: PriorCaseRow, keys: SearchKeys): number {
  const engineOk =
    keys.engine != null && matchEngine(keys.engine, row.vehicle_engine) !== "none";
  const modelOk =
    keys.model != null && modelsMatch(keys.model, row.vehicle_model);
  if (keys.engine && keys.model && engineOk && modelOk) return 1;
  if (keys.engine && engineOk) return 2;
  if (keys.model && modelOk) return 3;
  return 4;
}

function pickDtcCandidates(
  rows: PriorCaseRow[],
  keys: SearchKeys,
): PriorCaseRow[] {
  return [...rows]
    .map((row) => ({ row, priority: dtcRowPriority(row, keys) }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return compareStable(a.row, b.row);
    })
    .slice(0, MAX_CANDIDATES)
    .map((item) => item.row);
}

function appendUnique(
  out: PriorCaseRow[],
  rows: PriorCaseRow[],
  accept: (row: PriorCaseRow) => boolean,
): void {
  const seen = new Set(out.map((r) => r.id));
  const sorted = [...rows].sort(compareStable);
  for (const row of sorted) {
    if (out.length >= MAX_CANDIDATES) return;
    if (seen.has(row.id) || !accept(row)) continue;
    seen.add(row.id);
    out.push(row);
  }
}

async function searchPriorResolvedCases(
  supabase: UserSupabase,
  query: PriorCaseSearchInput,
): Promise<PriorResolvedCaseHint[]> {
  const keys = searchableKeys(query);
  if (!keys) return [];

  const dtcOr =
    keys.dtcs.length > 0
      ? keys.dtcs
          .flatMap((code) => {
            const p = ilikeContains(code);
            return [`problem_text.ilike.${p}`, `confirmed_fault.ilike.${p}`];
          })
          .join(",")
      : null;
  const engineOr = keys.engine
    ? `vehicle_engine.ilike.${ilikeContains(keys.engine)}`
    : null;
  const modelOr = keys.model
    ? `vehicle_model.ilike.${ilikeContains(keys.model)}`
    : null;

  const ex = query.excludeCaseId;
  const make = keys.make;
  const picked: PriorCaseRow[] = [];

  // Single DTC fetch → rank by priority in memory (no 4× duplicate DTC queries).
  if (dtcOr) {
    const dtcRows = await fetchMatchingRows(
      supabase,
      ex,
      make,
      dtcOr,
      DTC_FETCH_CAP,
    );
    picked.push(...pickDtcCandidates(dtcRows, keys));
  }

  // Fill remaining slots: motor, then model (only if needed).
  if (picked.length < MAX_CANDIDATES && engineOr && keys.engine) {
    const engineRows = await fetchMatchingRows(
      supabase,
      ex,
      make,
      engineOr,
      MAX_CANDIDATES,
    );
    appendUnique(
      picked,
      engineRows,
      (row) => matchEngine(keys.engine, row.vehicle_engine) !== "none",
    );
  }

  if (picked.length < MAX_CANDIDATES && modelOr && keys.model) {
    const modelRows = await fetchMatchingRows(
      supabase,
      ex,
      make,
      modelOr,
      MAX_CANDIDATES,
    );
    appendUnique(picked, modelRows, (row) =>
      modelsMatch(keys.model, row.vehicle_model),
    );
  }

  return picked.map(toHint);
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

/** Server search/cache only — client priorResolvedHints are ignored. */
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
    const row: Record<string, string> = { source: item.source };
    if (item.vehicle) row.vehicle = item.vehicle;
    if (item.problem) row.problem = item.problem;
    if (item.resolvedFault) row.resolvedFault = item.resolvedFault;
    if (item.diagnosisCertainty) {
      row.diagnosisCertainty = item.diagnosisCertainty;
    }
    return row;
  });
  return [
    "PRIOR_RESOLVED_CASE_CANDIDATES (backend shortlist iz prošlih kvarova istog korisnika. Ti procijeni tehničku relevantnost prema vozilu, motoru, simptomima, DTC i rezultatima OVOG slučaja. Smiješ zanemariti sve. Samo tragovi, nikad dokaz. Ne preskači potrebne TEST. Ne diži diagnosisCertainty zbog sličnog prošlog kvara. source/diagnosisCertainty su izvorni podaci slučaja — ne pretpostavljaj tko je potvrdio kvar.):",
    JSON.stringify(compact),
  ].join("\n");
}
