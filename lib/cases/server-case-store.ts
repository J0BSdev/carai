import { caseForStorage, storedCaseFields } from "@/lib/cases/stored-case";
import type { DiagnosticCase } from "@/lib/diagnosis/types";
import { createClient } from "@/lib/supabase/server";

export type CaseRecord = {
  caseData: DiagnosticCase;
  version: number;
  turnLockStepId: string | null;
  turnLockUntil: string | null;
  turnLockToken: string | null;
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
    turnLockToken: string | null;
    userId: string | null;
  }
>();

function rowToRecord(row: {
  case_data: unknown;
  case_version: number;
  turn_lock_step_id: string | null;
  turn_lock_until: string | null;
  turn_lock_token: string | null;
}): CaseRecord {
  return {
    caseData: caseForStorage(row.case_data),
    version: row.case_version,
    turnLockStepId: row.turn_lock_step_id,
    turnLockUntil: row.turn_lock_until,
    turnLockToken: row.turn_lock_token,
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
    turn_lock_token: null as string | null,
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
      turnLockToken: row.turnLockToken,
    };
  }

  const supabase = await createClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("diagnostic_cases")
    .select(
      "case_data, case_version, turn_lock_step_id, turn_lock_until, turn_lock_token, source",
    )
    .eq("id", caseId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[server-case-store] load", error.message);
    throw new Error("Dohvat slučaja nije uspio.");
  }
  if (!data) return null;
  // Manual rows are not diagnosable — same as a missing CarAI case (404 path).
  if (data.source === "manual") return null;
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
      turnLockToken: null,
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
    throw new Error("Spremanje slučaja nije uspjelo.");
  }
  return 1;
}

/**
 * Acquire an exclusive turn lock. Returns a unique lockToken, or null if busy.
 * Only unlocked / expired locks may be taken — prevents concurrent same-step runs.
 */
export async function tryAcquireTurnLock(
  caseId: string,
  expectedVersion: number,
  stepId: string,
  userId: string | null,
): Promise<string | null> {
  const lockToken = crypto.randomUUID();
  const untilMs = Date.now() + TURN_LOCK_MS;
  const nowIso = new Date().toISOString();
  const untilIso = new Date(untilMs).toISOString();

  if (!userId) {
    const row = ephemeral.get(caseId);
    if (!row || row.version !== expectedVersion) return null;
    if (row.turnLockUntil != null && row.turnLockUntil > Date.now()) {
      return null;
    }
    row.turnLockStepId = stepId;
    row.turnLockUntil = untilMs;
    row.turnLockToken = lockToken;
    return lockToken;
  }

  const supabase = await createClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("diagnostic_cases")
    .update({
      turn_lock_step_id: stepId,
      turn_lock_until: untilIso,
      turn_lock_token: lockToken,
    })
    .eq("id", caseId)
    .eq("user_id", userId)
    .eq("case_version", expectedVersion)
    .or(`turn_lock_until.is.null,turn_lock_until.lt."${nowIso}"`)
    .select("id");

  if (error) {
    console.error("[server-case-store] lock", error.message);
    return null;
  }
  return (data?.length ?? 0) > 0 ? lockToken : null;
}

/**
 * CAS write: requires matching case_version AND lockToken, and a still-valid lock.
 * Clears the lock on success. Stale holders (expired / stolen lock) cannot commit.
 */
export async function commitCaseUpdate(
  diagnosticCase: DiagnosticCase,
  expectedVersion: number,
  lockToken: string,
  userId: string | null,
): Promise<number | null> {
  const stored = caseForStorage(diagnosticCase);
  const nextVersion = expectedVersion + 1;
  const nowIso = new Date().toISOString();

  if (!userId) {
    const row = ephemeral.get(stored.id);
    if (!row || row.version !== expectedVersion) return null;
    if (row.turnLockToken !== lockToken) return null;
    if (row.turnLockUntil == null || row.turnLockUntil <= Date.now()) return null;
    row.caseData = stored;
    row.version = nextVersion;
    row.turnLockStepId = null;
    row.turnLockUntil = null;
    row.turnLockToken = null;
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
        turn_lock_token: null,
      })
      .eq("id", stored.id)
      .eq("user_id", userId)
      .eq("case_version", expectedVersion)
      .eq("turn_lock_token", lockToken)
      .gt("turn_lock_until", nowIso)
      .select("case_version");

    if (!error) {
      if (!data?.length) return null;
      return nextVersion;
    }
    console.error("[server-case-store] commit", error.message);
    if (attempt === SAVE_ATTEMPTS - 1) {
      throw new Error("Spremanje slučaja nije uspjelo.");
    }
  }
  return null;
}

/** Release only the lock owned by this lockToken. */
export async function releaseTurnLock(
  caseId: string,
  expectedVersion: number,
  lockToken: string,
  userId: string | null,
): Promise<void> {
  if (!userId) {
    const row = ephemeral.get(caseId);
    if (!row || row.version !== expectedVersion) return;
    if (row.turnLockToken !== lockToken) return;
    row.turnLockStepId = null;
    row.turnLockUntil = null;
    row.turnLockToken = null;
    return;
  }

  const supabase = await createClient();
  if (!supabase) return;

  await supabase
    .from("diagnostic_cases")
    .update({
      turn_lock_step_id: null,
      turn_lock_until: null,
      turn_lock_token: null,
    })
    .eq("id", caseId)
    .eq("user_id", userId)
    .eq("case_version", expectedVersion)
    .eq("turn_lock_token", lockToken);
}

/** True when a non-expired turn lock is held. */
export function isTurnLocked(record: CaseRecord): boolean {
  if (!record.turnLockUntil || !record.turnLockToken) return false;
  const until = Date.parse(record.turnLockUntil);
  if (Number.isNaN(until) || until <= Date.now()) return false;
  return true;
}
