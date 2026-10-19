import { parseDiagnosticCase } from "@/lib/diagnosis/case-parse";
import type { DiagnosticCase } from "@/lib/diagnosis/types";

const MAX_STORED_CHARS = 400_000;

const MEDIA_KEYS = new Set([
  "image",
  "images",
  "photo",
  "photos",
  "base64",
  "image_url",
  "dataUrl",
  "mediaType",
  "media_type",
]);

function stripMedia(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      throw new Error("Slika se ne sprema u bazu.");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(stripMedia);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (MEDIA_KEYS.has(key)) continue;
    out[key] = stripMedia(child);
  }
  return out;
}

/** DiagnosticCase safe to store. Photos and base64 never pass through. */
export function caseForStorage(value: unknown): DiagnosticCase {
  const stripped = stripMedia(value);
  const encoded = JSON.stringify(stripped);
  if (encoded.length > MAX_STORED_CHARS) {
    throw new Error("Slučaj je prevelik za spremanje.");
  }
  const parsed = parseDiagnosticCase(stripped);
  if (!parsed.priorResolvedHints) return parsed;
  const rest = { ...parsed };
  delete rest.priorResolvedHints;
  return rest;
}

export type StoredCaseStatus = "active" | "finished";

export type StoredCaseFields = {
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleEngine: string | null;
  problemText: string;
  confirmedFault: string | null;
  status: StoredCaseStatus;
};

function storedText(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/** Columns copied from the case. No model call. An open case has no fault. */
export function storedCaseFields(diagnosticCase: DiagnosticCase): StoredCaseFields {
  const vehicle = diagnosticCase.extracted?.vehicle;
  const last = diagnosticCase.steps[diagnosticCase.steps.length - 1];
  const finished = last?.actionType === "FINISH";
  return {
    vehicleMake: storedText(vehicle?.make),
    vehicleModel: storedText(vehicle?.model),
    vehicleYear: typeof vehicle?.year === "number" ? vehicle.year : null,
    vehicleEngine: storedText(vehicle?.engine),
    problemText: diagnosticCase.problemText,
    confirmedFault: finished ? storedText(last?.confirmedFault) : null,
    status: finished ? "finished" : "active",
  };
}
