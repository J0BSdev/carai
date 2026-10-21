import { caseForStorage, storedCaseFields } from "@/lib/cases/stored-case";
import type { DiagnosticCase } from "@/lib/diagnosis/types";
import { createClient } from "@/lib/supabase/server";

export type CaseRecord = {
  caseData: DiagnosticCase;
  version: number;
  turnLockStepId: string | null;
  turnLockUntil: string | null;
};

const TURN_LOCK_MS = 120_000;
const SAVE_ATTEMPTS = 3;

/** Process-local store when diagnose runs without a signed-in user (local dev). */
const ephemeral = new Map<
  string,
  {
    caseData: DiagnosticCase;
    version: number;
    turnLockStepId: string | null;
    turnLockUntil: number | null;
    userId: string | null;
  }
>();

function rowToRecord(row: {
  case_data: unknown;
  case_version: number;
  turn_lock_step_id: string | null;
  turn_lock_until: string | null;
  source?: string;
}): CaseRecord {
  if (row.source === "manual") {
    throw new Error("Ručno unesen kvar nema CarAI dijagnostiku.");
  }
  return {
    caseData: caseForStorage(row.case_data),
    version: row.case_version,
    turnLockStepId: row.turn_lock_step_id,
    turnLockUntil: row.turn_lock_until,
  };
}

function upsertPayload(diagnosticCase: DiagnosticCase, userId: string, version: number) {
  const stored = caseForStorage(diagnosticCase);
  const fields = storedCaseFields(stored);
  return {
    id: stored.id,
    user_id: userId,
    created_at: stored.createdAt,
    problem_text: fields.problemText,
    vehicle_make: fields.vehicleMake,
    vehicle_model: fields.vehicleModel,
    vehicle_year: fields.vehicleYear,
    vehicle_engine: fields.vehicleEngine,
    confirmed_fault: fields.confirmedFault,
    status: fields.status,
    source: "carai" as const,
    case_data: stored,
    case_version: version,
    turn_lock_step_id: null as string | null,
    turn_lock_until: null as string | null,
  };
}

export async function loadOwnedCase(
  caseId: string,
  userId: string | null,
): Promise<CaseRecord | null> {
  if (!userId) {
    const row = ephemeral.get(caseId);
    if (!row) return null;
    return {
      caseData: caseForStorage(row.caseData),
      version: row.version,
      turnLockStepId: row.turnLockStepId,
      turnLockUntil:
        row.turnLockUntil != null ? new Date(row.turnLockUntil).toISOString() : null,
    };
  }

  const supabase = await createClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("diagnostic_cases")
    .select(
      "case_data, case_version, turn_lock_step_id, turn_lock_until, source",
    )
    .eq("id", caseId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[server-case-store] load", error.message);
    throw new Error("Dohvat slučaja nije uspio.");
  }
  if (!data) return null;
  return rowToRecord(data);
}

/** Insert new case after START. version = 1. */
export async function insertStartedCase(
  diagnosticCase: DiagnosticCase,
  userId: string | null,
): Promise<number> {
  const stored = caseForStorage(diagnosticCase);
  if (!userId) {
    ephemeral.set(stored.id, {
      caseData: stored,
      version: 1,
      turnLockStepId: null,
      turnLockUntil: null,
      userId: null,
    });
    return 1;
  }

  const supabase = await createClient();
  if (!supabase) {
    throw new Error("Supabase nije dostupan za spremanje.");
  }

  const { error } = await supabase
    .from("diagnostic_cases")
    .insert(upsertPayload(stored, userId, 1));
  if (error) {
    console.error("[server-case-store] insert", error.message);
    // Do not retry inserts: a timed-out success + retry would hit a duplicate key
    // and hide the fact that the row already exists.
    throw new Error("Spremanje slučaja nije uspjelo.");
  }
  return 1;
}

export async function tryAcquireTurnLock(
  caseId: string,
  expectedVersion: number,
  stepId: string,
  userId: string | null,
): Promise<boolean> {
  const untilMs = Date.now() + TURN_LOCK_MS;
  const nowIso = new Date().toISOString();
  const untilIso = new Date(untilMs).toISOString();

  if (!userId) {
    const row = ephemeral.get(caseId);
    if (!row || row.version !== expectedVersion) return false;
    // Held by anyone (including same step) → reject; only expired/null may acquire.
    if (row.turnLockUntil != null && row.turnLockUntil > Date.now()) {
      return false;
    }
    row.turnLockStepId = stepId;
    row.turnLockUntil = untilMs;
    return true;
  }

  const supabase = await createClient();
  if (!supabase) return false;

  // Single atomic UPDATE: version match AND (unlocked OR expired).
  // Two concurrent callers cannot both succeed — the second sees an active lock.
  const { data, error } = await supabase
    .from("diagnostic_cases")
    .update({
      turn_lock_step_id: stepId,
      turn_lock_until: untilIso,
    })
    .eq("id", caseId)
    .eq("user_id", userId)
    .eq("case_version", expectedVersion)
    .or(`turn_lock_until.is.null,turn_lock_until.lt."${nowIso}"`)
    .select("id");

  if (error) {
    console.error("[server-case-store] lock", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** CAS write of full case_data; clears turn lock. Returns new version or null on conflict. */
export async function commitCaseUpdate(
  diagnosticCase: DiagnosticCase,
  expectedVersion: number,
  userId: string | null,
): Promise<number | null> {
  const stored = caseForStorage(diagnosticCase);
  const nextVersion = expectedVersion + 1;

  if (!userId) {
    const row = ephemeral.get(stored.id);
    if (!row || row.version !== expectedVersion) return null;
    row.caseData = stored;
    row.version = nextVersion;
    row.turnLockStepId = null;
    row.turnLockUntil = null;
    return nextVersion;
  }

  const supabase = await createClient();
  if (!supabase) {
    throw new Error("Supabase nije dostupan za spremanje.");
  }

  const fields = storedCaseFields(stored);

  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const { data, error } = await supabase
      .from("diagnostic_cases")
      .update({
        problem_text: fields.problemText,
        vehicle_make: fields.vehicleMake,
        vehicle_model: fields.vehicleModel,
        vehicle_year: fields.vehicleYear,
        vehicle_engine: fields.vehicleEngine,
        confirmed_fault: fields.confirmedFault,
        status: fields.status,
        source: "carai",
        case_data: stored,
        case_version: nextVersion,
        turn_lock_step_id: null,
        turn_lock_until: null,
      })
      .eq("id", stored.id)
      .eq("user_id", userId)
      .eq("case_version", expectedVersion)
      .select("case_version");

    if (!error) {
      if (!data?.length) return null; // CAS conflict — do not retry
      return nextVersion;
    }
    console.error("[server-case-store] commit", error.message);
    if (attempt === SAVE_ATTEMPTS - 1) {
      throw new Error("Spremanje slučaja nije uspjelo.");
    }
  }
  return null;
}

export async function releaseTurnLock(
  caseId: string,
  expectedVersion: number,
  stepId: string,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    const row = ephemeral.get(caseId);
    if (!row || row.version !== expectedVersion) return;
    if (row.turnLockStepId === stepId) {
      row.turnLockStepId = null;
      row.turnLockUntil = null;
    }
    return;
  }

  const supabase = await createClient();
  if (!supabase) return;

  await supabase
    .from("diagnostic_cases")
    .update({ turn_lock_step_id: null, turn_lock_until: null })
    .eq("id", caseId)
    .eq("user_id", userId)
    .eq("case_version", expectedVersion)
    .eq("turn_lock_step_id", stepId);
}

/** True when another in-flight turn holds a non-expired lock. */
export function isTurnLocked(record: CaseRecord, _stepId: string): boolean {
  if (!record.turnLockUntil || !record.turnLockStepId) return false;
  const until = Date.parse(record.turnLockUntil);
  if (Number.isNaN(until) || until <= Date.now()) return false;
  return true;
}
