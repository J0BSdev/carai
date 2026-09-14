import type { DiagnosticCase, VehicleInfo } from "./types";
import { buildKnownFactsSnapshot } from "./known-facts";

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9čćžšđ\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asksForDtcInventoryOrRescan(normalized: string): boolean {
  const asksInventory =
    /(ocitaj|ocitati|procitaj|skenir|scan|provjeri).{0,40}(dtc|kod|fault|gresk)/.test(
      normalized,
    ) ||
    /(ima li|postoji li|koji su|navedi|popis).{0,40}(dtc|kod|fault|gresk)/.test(
      normalized,
    ) ||
    /(dtc|kodovi|fault codes).{0,40}(ocitaj|ocitati|skenir|scan)/.test(
      normalized,
    );

  if (!asksInventory) return false;

  // Detail questions about an already-known code are allowed
  const asksDetailOnly =
    /(status|opis|znacenj|značenj|freeze|pending|confirmed|aktiv|povijest|frame).{0,30}(dtc|kod|df\d|[pcbu][0-9a-f]{4})/.test(
      normalized,
    ) ||
    /(status|opis).{0,20}(df\d|[pcbu][0-9a-f]{4})/.test(normalized);

  return !asksDetailOnly;
}

function asksForAlreadyKnownVehicle(
  normalized: string,
  vehicle: VehicleInfo,
): boolean {
  const asksMakeModel =
    /(koja|koje|koji).{0,20}(marka|model|godina|vozilo)/.test(normalized) ||
    /(potvrdi|navedi).{0,30}(marka|model|godina|motor|kilometraz)/.test(
      normalized,
    ) ||
    /(marka|model|godina).{0,20}(vozila|auta)/.test(normalized);

  if (!asksMakeModel) return false;

  const knownBits = [
    vehicle.make,
    vehicle.model,
    vehicle.year?.toString(),
  ].filter(Boolean).length;
  // Only block if we already have usable identity
  return knownBits >= 2;
}

/**
 * Reject ASK/TEST that re-request information already present in known facts.
 * Allows asking for unknown details about a known code (status/description).
 */
export function findAlreadyKnownInfoIssue(
  diagnosticCase: DiagnosticCase,
  draft: { actionType?: string; content?: string; rationale?: string },
): string | null {
  if (draft.actionType !== "ASK" && draft.actionType !== "TEST") return null;
  const content = `${draft.content ?? ""} ${draft.rationale ?? ""}`.trim();
  if (!content) return null;

  const known = buildKnownFactsSnapshot(diagnosticCase);
  const normalized = normalizeForCompare(content);

  if (
    known.knownDtcCodes.length > 0 &&
    asksForDtcInventoryOrRescan(normalized)
  ) {
    return (
      `KNOWN FACTS: DTC kodovi su već poznati (${known.knownDtcCodes.join(", ")}). ` +
      "Ne traži ponovno očitavanje/popis DTC-ova. " +
      "Ako treba detalj, pitaj status/opis konkretnog poznatog koda — ili odaberi sljedeći dijagnostički TEST na temelju poznatih kodova."
    );
  }

  // If draft asks "which DTC" while codes known
  if (
    known.knownDtcCodes.length > 0 &&
    /(koji|kakav).{0,15}(dtc|kod|gresk)/.test(normalized) &&
    !/(status|opis)/.test(normalized)
  ) {
    return (
      `KNOWN FACTS: već postoje DTC kodovi (${known.knownDtcCodes.join(", ")}). Ne pitaj koji je kod.`
    );
  }

  if (known.vehicle && asksForAlreadyKnownVehicle(normalized, known.vehicle)) {
    return (
      "KNOWN FACTS: podaci o vozilu su već u case stateu. Ne pitaj ponovno marku/model/godinu koje su poznate."
    );
  }

  return null;
}
