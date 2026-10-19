"use server";

import { caseForStorage, storedCaseFields, type StoredCaseStatus } from "@/lib/cases/stored-case";
import type { DiagnosisCertainty, DiagnosticCase } from "@/lib/diagnosis/types";
import { createClient } from "@/lib/supabase/server";

const CERTAINTIES = new Set<DiagnosisCertainty>([
  "SUSPECTED",
  "LIKELY",
  "HIGH_CONFIDENCE",
  "CONFIRMED",
]);

export type CaseSource = "carai" | "manual";

export type CaseSummary = {
  id: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleEngine: string | null;
  problemText: string;
  confirmedFault: string | null;
  status: StoredCaseStatus;
  source: CaseSource;
  /** From the open FINISH step; null for manual entries and open ASK/TEST. */
  diagnosisCertainty: DiagnosisCertainty | null;
  createdAt: string;
  updatedAt: string;
};

export type ManualResolvedFaultInput = {
  /** When set, updates that manual row. Create when omitted. */
  id?: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleEngine?: string;
  vehicleYear?: number | null;
  /** Optional symptoms / reason for visit. Stored in problem_text. */
  problemText?: string;
  confirmedFault: string;
};

export type CaseStoreFailure = {
  ok: false;
  code: "UNCONFIGURED" | "UNAUTHENTICATED" | "INVALID" | "NOT_FOUND" | "FAILED";
  message: string;
};

export type CaseStoreResult<T> = { ok: true; data: T } | CaseStoreFailure;

type CaseListRow = {
  id: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: number | null;
  vehicle_engine: string | null;
  problem_text: string;
  confirmed_fault: string | null;
  status: string;
  source: string;
  diagnosis_certainty: string | null;
  created_at: string;
  updated_at: string;
};

function summaryStatus(value: string): StoredCaseStatus {
  return value === "finished" ? "finished" : "active";
}

function summarySource(value: string): CaseSource {
  return value === "manual" ? "manual" : "carai";
}

function octetLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function rejectImageText(value: string): boolean {
  return value.includes("data:image/");
}

function trimRequired(value: string, maxOctets: number): string | null {
  const text = value.trim();
  if (!text) return null;
  if (octetLength(text) > maxOctets) return null;
  if (rejectImageText(text)) return null;
  return text;
}

function trimOptional(value: string | undefined, maxOctets: number): string | null {
  if (value == null) return null;
  const text = value.trim();
  if (!text) return null;
  if (octetLength(text) > maxOctets) return null;
  if (rejectImageText(text)) return null;
  return text;
}

function summaryCertainty(value: string | null): DiagnosisCertainty | null {
  if (!value || !CERTAINTIES.has(value as DiagnosisCertainty)) return null;
  return value as DiagnosisCertainty;
}

async function userId(): Promise<
  { supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>; id: string } | CaseStoreFailure
> {
  const supabase = await createClient();
  if (!supabase) {
    return {
      ok: false,
      code: "UNCONFIGURED",
      message: "Supabase nije konfiguriran.",
    };
  }
  const { data, error } = await supabase.auth.getClaims();
  const id = data?.claims?.sub;
  if (error || !id) {
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      message: "Prijava je potrebna za spremanje slučaja.",
    };
  }
  return { supabase, id };
}

export async function saveDiagnosticCase(
  input: DiagnosticCase,
): Promise<CaseStoreResult<{ id: string }>> {
  const auth = await userId();
  if ("ok" in auth) return auth;

  let stored: DiagnosticCase;
  try {
    stored = caseForStorage(input);
  } catch {
    return {
      ok: false,
      code: "INVALID",
      message: "Slučaj nije valjan za spremanje.",
    };
  }

  const fields = storedCaseFields(stored);
  const { data: existing, error: readError } = await auth.supabase
    .from("diagnostic_cases")
    .select("case_data, source")
    .eq("id", stored.id)
    .maybeSingle();
  if (!readError && existing?.source === "manual") {
    return {
      ok: false,
      code: "INVALID",
      message: "Ručno unesen kvar nije AI dijagnostika.",
    };
  }
  if (!readError && existing?.case_data) {
    try {
      const previous = caseForStorage(existing.case_data);
      if (JSON.stringify(previous) === JSON.stringify(stored)) {
        return { ok: true, data: { id: stored.id } };
      }
    } catch {
      // The stored row is not comparable, so replace it.
    }
  }

  const { error } = await auth.supabase.from("diagnostic_cases").upsert(
    {
      id: stored.id,
      user_id: auth.id,
      created_at: stored.createdAt,
      problem_text: fields.problemText,
      vehicle_make: fields.vehicleMake,
      vehicle_model: fields.vehicleModel,
      vehicle_year: fields.vehicleYear,
      vehicle_engine: fields.vehicleEngine,
      confirmed_fault: fields.confirmedFault,
      status: fields.status,
      source: "carai",
      case_data: stored,
    },
    { onConflict: "id" },
  );

  if (error) {
    console.error("saveDiagnosticCase", error.code);
    return {
      ok: false,
      code: "FAILED",
      message: "Spremanje slučaja nije uspjelo.",
    };
  }
  return { ok: true, data: { id: stored.id } };
}

type ParsedManualFault = {
  vehicleMake: string;
  vehicleModel: string;
  vehicleEngine: string | null;
  vehicleYear: number | null;
  problemText: string;
  confirmedFault: string;
};

function parseManualFault(
  input: ManualResolvedFaultInput,
): ParsedManualFault | CaseStoreFailure {
  const vehicleMake = trimRequired(input.vehicleMake, 200);
  const vehicleModel = trimRequired(input.vehicleModel, 200);
  const confirmedFault = trimRequired(input.confirmedFault, 4000);
  if (!vehicleMake || !vehicleModel || !confirmedFault) {
    return {
      ok: false,
      code: "INVALID",
      message: "Marka, model i utvrđeni kvar su obavezni.",
    };
  }

  const vehicleEngine = trimOptional(input.vehicleEngine, 200);
  if (input.vehicleEngine?.trim() && vehicleEngine == null) {
    return {
      ok: false,
      code: "INVALID",
      message: "Motor nije valjan.",
    };
  }

  let vehicleYear: number | null = null;
  if (input.vehicleYear != null && input.vehicleYear !== undefined) {
    if (
      typeof input.vehicleYear !== "number" ||
      !Number.isInteger(input.vehicleYear) ||
      input.vehicleYear < 1900 ||
      input.vehicleYear > 2100
    ) {
      return {
        ok: false,
        code: "INVALID",
        message: "Godina mora biti između 1900 i 2100.",
      };
    }
    vehicleYear = input.vehicleYear;
  }

  const problemRaw = input.problemText ?? "";
  if (problemRaw.trim() && trimOptional(problemRaw, 20000) == null) {
    return {
      ok: false,
      code: "INVALID",
      message: "Simptomi / razlog dolaska nisu valjani.",
    };
  }
  const problemText = trimOptional(problemRaw, 20000) ?? "";

  return {
    vehicleMake,
    vehicleModel,
    vehicleEngine,
    vehicleYear,
    problemText,
    confirmedFault,
  };
}

function manualCaseData(fields: ParsedManualFault) {
  return {
    entry: "manual_resolved_fault",
    vehicle: {
      make: fields.vehicleMake,
      model: fields.vehicleModel,
      ...(fields.vehicleEngine ? { engine: fields.vehicleEngine } : {}),
      ...(fields.vehicleYear != null ? { year: fields.vehicleYear } : {}),
    },
    ...(fields.problemText ? { problemText: fields.problemText } : {}),
    confirmedFault: fields.confirmedFault,
  };
}

/** Mechanic-entered resolved fault. No AI steps and no model calls. */
export async function saveManualResolvedFault(
  input: ManualResolvedFaultInput,
): Promise<CaseStoreResult<{ id: string }>> {
  const auth = await userId();
  if ("ok" in auth) return auth;

  const parsed = parseManualFault(input);
  if ("ok" in parsed) return parsed;

  const caseData = manualCaseData(parsed);
  const columns = {
    problem_text: parsed.problemText,
    vehicle_make: parsed.vehicleMake,
    vehicle_model: parsed.vehicleModel,
    vehicle_year: parsed.vehicleYear,
    vehicle_engine: parsed.vehicleEngine,
    confirmed_fault: parsed.confirmedFault,
    status: "finished" as const,
    case_data: caseData,
  };

  if (input.id) {
    const { data, error } = await auth.supabase
      .from("diagnostic_cases")
      .update(columns)
      .eq("id", input.id)
      .eq("source", "manual")
      .eq("user_id", auth.id)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("saveManualResolvedFault", error.code);
      return {
        ok: false,
        code: "FAILED",
        message: "Spremanje kvara nije uspjelo.",
      };
    }
    if (!data?.id) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Ručno unesen kvar nije pronađen.",
      };
    }
    return { ok: true, data: { id: data.id } };
  }

  const id = crypto.randomUUID();
  const { error } = await auth.supabase.from("diagnostic_cases").insert({
    id,
    user_id: auth.id,
    created_at: new Date().toISOString(),
    source: "manual",
    ...columns,
  });

  if (error) {
    console.error("saveManualResolvedFault", error.code);
    return {
      ok: false,
      code: "FAILED",
      message: "Spremanje kvara nije uspjelo.",
    };
  }
  return { ok: true, data: { id } };
}

export async function listDiagnosticCases(): Promise<CaseStoreResult<CaseSummary[]>> {
  const auth = await userId();
  if ("ok" in auth) return auth;

  const { data, error } = await auth.supabase
    .from("diagnostic_cases")
    .select(
      "id, vehicle_make, vehicle_model, vehicle_year, vehicle_engine, problem_text, confirmed_fault, status, source, diagnosis_certainty, created_at, updated_at",
    )
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("listDiagnosticCases", error.code);
    return {
      ok: false,
      code: "FAILED",
      message: "Dohvat slučajeva nije uspio.",
    };
  }

  const rows = (data ?? []) as CaseListRow[];
  return {
    ok: true,
    data: rows.map((row) => {
      const source = summarySource(row.source);
      return {
        id: row.id,
        vehicleMake: row.vehicle_make,
        vehicleModel: row.vehicle_model,
        vehicleYear: row.vehicle_year,
        vehicleEngine: row.vehicle_engine,
        problemText: row.problem_text,
        confirmedFault: row.confirmed_fault,
        status: summaryStatus(row.status),
        source,
        diagnosisCertainty:
          source === "manual" ? null : summaryCertainty(row.diagnosis_certainty),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
  };
}

export async function loadDiagnosticCase(
  id: string,
): Promise<CaseStoreResult<DiagnosticCase>> {
  const auth = await userId();
  if ("ok" in auth) return auth;

  const { data, error } = await auth.supabase
    .from("diagnostic_cases")
    .select("case_data, source")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("loadDiagnosticCase", error.code);
    return {
      ok: false,
      code: "FAILED",
      message: "Dohvat slučaja nije uspio.",
    };
  }
  if (!data?.case_data) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Slučaj nije pronađen.",
    };
  }
  if (data.source === "manual") {
    return {
      ok: false,
      code: "INVALID",
      message: "Ručno unesen kvar nema CarAI dijagnostiku.",
    };
  }

  try {
    return { ok: true, data: caseForStorage(data.case_data) };
  } catch {
    return {
      ok: false,
      code: "INVALID",
      message: "Spremljeni slučaj nije valjan.",
    };
  }
}
