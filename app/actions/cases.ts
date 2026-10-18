"use server";

import { caseForStorage } from "@/lib/cases/stored-case";
import type { DiagnosticCase } from "@/lib/diagnosis/types";
import { createClient } from "@/lib/supabase/server";

export type CaseSummary = {
  id: string;
  problemText: string;
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
  problem_text: string;
  created_at: string;
  updated_at: string;
};

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

  const { error } = await auth.supabase.from("diagnostic_cases").upsert(
    {
      id: stored.id,
      user_id: auth.id,
      created_at: stored.createdAt,
      problem_text: stored.problemText,
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
    .select("id, problem_text, created_at, updated_at")
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
      problemText: row.problem_text,
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
