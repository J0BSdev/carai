import { createClient } from "@/lib/supabase/server";
import type {
  DiagnosticCase,
  PriorResolvedCaseHint,
  PriorResolvedHints,
  VehicleInfo,
} from "@/lib/diagnosis/types";

/** Max short candidates sent to Claude (Claude judges relevance). */
const MAX_CANDIDATES = 8;
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

/** DTC, model, or engine — enough to search without dumping unrelated history. */
function searchableKeys(query: PriorCaseSearchInput): {
  make: string | null;
  model: string | null;
  engine: string | null;
  dtcs: string[];
} | null {
  const make = query.vehicle?.make?.trim() ?? "";
  const model = query.vehicle?.model?.trim() ?? "";
  const engine = query.vehicle?.engine?.trim() ?? "";
  const dtcs = extractDtcCodes(
    query.problemText,
    ...(query.dtcs ?? []),
  ).slice(0, 8);

  const hasModel = model.length >= 2;
  const hasEngine = engine.length >= 2;
  const hasDtc = dtcs.length > 0;
  if (!hasModel && !hasEngine && !hasDtc) return null;

  return {
    make: make.length >= 2 ? make : null,
    model: hasModel ? model : null,
    engine: hasEngine ? engine : null,
    dtcs,
  };
}

function toHint(row: PriorCaseRow): PriorResolvedCaseHint | null {
  const source = row.source === "manual" ? "manual" : "carai";
  if (source === "carai") {
    const c = row.diagnosis_certainty;
    if (c !== "CONFIRMED" && c !== "HIGH_CONFIDENCE") return null;
  }

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

/**
 * SQL narrows by model / engine / DTC (any age). Optional make scopes the brand.
 * No symptom-token filters. No "newest N then hope".
 */
async function searchPriorResolvedCases(
  supabase: UserSupabase,
  query: PriorCaseSearchInput,
): Promise<PriorResolvedCaseHint[]> {
  const keys = searchableKeys(query);
  if (!keys) return [];

  let builder = supabase
    .from("diagnostic_cases")
    .select(
      "id, vehicle_make, vehicle_model, vehicle_year, vehicle_engine, problem_text, confirmed_fault, source, diagnosis_certainty",
    )
    .neq("id", query.excludeCaseId)
    .or(
      "source.eq.manual,diagnosis_certainty.eq.CONFIRMED,diagnosis_certainty.eq.HIGH_CONFIDENCE",
    );

  if (keys.make) {
    builder = builder.ilike("vehicle_make", ilikeContains(keys.make));
  }

  const orParts: string[] = [];
  if (keys.model) {
    orParts.push(`vehicle_model.ilike.${ilikeContains(keys.model)}`);
  }
  if (keys.engine) {
    orParts.push(`vehicle_engine.ilike.${ilikeContains(keys.engine)}`);
  }
  for (const code of keys.dtcs) {
    const p = ilikeContains(code);
    orParts.push(`problem_text.ilike.${p}`);
    orParts.push(`confirmed_fault.ilike.${p}`);
  }
  builder = builder.or(orParts.join(","));

  const { data, error } = await builder
    .order("updated_at", { ascending: false })
    .limit(MAX_CANDIDATES);

  if (error || !data?.length) return [];

  const hints: PriorResolvedCaseHint[] = [];
  for (const row of data as PriorCaseRow[]) {
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
