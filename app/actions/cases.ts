"use server";

import { caseForStorage, storedCaseFields, type StoredCaseStatus } from "@/lib/cases/stored-case";
import type { DiagnosticCase } from "@/lib/diagnosis/types";
import { createClient } from "@/lib/supabase/server";

export type CaseSummary = {
  id: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleEngine: string | null;
  problemText: string;
  confirmedFault: string | null;
  status: StoredCaseStatus;
  createdAt: string;
  updatedAt: string;
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
  created_at: string;
  updated_at: string;
};

function summaryStatus(value: string): StoredCaseStatus {
  return value === "finished" ? "finished" : "active";
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

export async function listDiagnosticCases(): Promise<CaseStoreResult<CaseSummary[]>> {
  const auth = await userId();
  if ("ok" in auth) return auth;

  const { data, error } = await auth.supabase
    .from("diagnostic_cases")
    .select(
      "id, vehicle_make, vehicle_model, vehicle_year, vehicle_engine, problem_text, confirmed_fault, status, created_at, updated_at",
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
    data: rows.map((row) => ({
      id: row.id,
      vehicleMake: row.vehicle_make,
      vehicleModel: row.vehicle_model,
      vehicleYear: row.vehicle_year,
      vehicleEngine: row.vehicle_engine,
      problemText: row.problem_text,
      confirmedFault: row.confirmed_fault,
      status: summaryStatus(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

export async function loadDiagnosticCase(
  id: string,
): Promise<CaseStoreResult<DiagnosticCase>> {
  const auth = await userId();
  if ("ok" in auth) return auth;

  const { data, error } = await auth.supabase
    .from("diagnostic_cases")
    .select("case_data")
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
