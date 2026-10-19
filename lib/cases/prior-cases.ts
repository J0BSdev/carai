import { createClient } from "@/lib/supabase/server";
import type {
  DiagnosticCase,
  PriorResolvedCaseHint,
  PriorResolvedHints,
  VehicleInfo,
} from "@/lib/diagnosis/types";

const FETCH_LIMIT = 80;
const TOP_N = 5;
const MIN_SCORE = 10;
const PROBLEM_SNIPPET = 120;

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

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9čćžšđüöä]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
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

function textBlob(row: PriorCaseRow): string {
  return [row.problem_text, row.confirmed_fault, vehicleLabel(row)]
    .filter(Boolean)
    .join(" ");
}

function scoreRow(row: PriorCaseRow, query: PriorCaseSearchInput): number {
  let score = 0;
  const qMake = norm(query.vehicle?.make);
  const qModel = norm(query.vehicle?.model);
  const qEngine = norm(query.vehicle?.engine);
  const qYear = query.vehicle?.year;
  const rMake = norm(row.vehicle_make);
  const rModel = norm(row.vehicle_model);
  const rEngine = norm(row.vehicle_engine);

  if (qMake) {
    if (rMake === qMake) score += 40;
    else if (rMake && (rMake.includes(qMake) || qMake.includes(rMake))) score += 20;
    else if (rMake) score -= 25;
  }

  if (qModel) {
    if (rModel === qModel) score += 30;
    else if (rModel && (rModel.includes(qModel) || qModel.includes(rModel)))
      score += 15;
  }

  if (qEngine) {
    if (rEngine === qEngine) score += 15;
    else if (
      rEngine &&
      (rEngine.includes(qEngine) || qEngine.includes(rEngine))
    ) {
      score += 8;
    }
  }

  if (qYear != null && row.vehicle_year === qYear) score += 5;

  const queryText = [
    query.problemText,
    ...(query.symptoms ?? []),
    ...(query.dtcs ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  const qTokens = new Set(tokens(queryText));
  const rTokens = tokens(textBlob(row));
  let overlap = 0;
  for (const t of rTokens) {
    if (qTokens.has(t)) overlap += 1;
  }
  score += Math.min(25, overlap * 5);

  const blobLower = textBlob(row).toLowerCase();
  for (const dtc of query.dtcs ?? []) {
    const code = dtc.trim().toUpperCase();
    if (code.length >= 4 && blobLower.includes(code.toLowerCase())) {
      score += 12;
    }
  }

  if (row.confirmed_fault?.trim()) score += 2;

  return score;
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

    const { data, error } = await supabase
      .from("diagnostic_cases")
      .select(
        "id, vehicle_make, vehicle_model, vehicle_year, vehicle_engine, problem_text, confirmed_fault, source, diagnosis_certainty",
      )
      .neq("id", query.excludeCaseId)
      .or(
        "source.eq.manual,diagnosis_certainty.eq.CONFIRMED,diagnosis_certainty.eq.HIGH_CONFIDENCE",
      )
      .order("updated_at", { ascending: false })
      .limit(FETCH_LIMIT);

    if (error || !data?.length) return [];

    const ranked = (data as PriorCaseRow[])
      .map((row) => ({ row, score: scoreRow(row, query) }))
      .filter((item) => item.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N)
      .map((item) => toHint(item.row));

    return ranked;
  } catch {
    return [];
  }
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
 * Attach or reuse prior-case hints on the case. Re-searches only when the
 * fingerprint (vehicle / symptoms / DTCs / complaint) changed.
 */
export async function attachPriorResolvedHints(
  diagnosticCase: DiagnosticCase,
): Promise<DiagnosticCase> {
  const fingerprint = priorSearchFingerprint(diagnosticCase);
  const cached = diagnosticCase.priorResolvedHints;
  if (cached?.fingerprint === fingerprint) {
    return diagnosticCase;
  }

  const items = await searchPriorResolvedCases({
    excludeCaseId: diagnosticCase.id,
    problemText: diagnosticCase.problemText,
    vehicle: diagnosticCase.extracted?.vehicle,
    symptoms: diagnosticCase.extracted?.symptoms,
    dtcs: diagnosticCase.extracted?.dtcs,
  });

  const priorResolvedHints: PriorResolvedHints = { fingerprint, items };
  return { ...diagnosticCase, priorResolvedHints };
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
