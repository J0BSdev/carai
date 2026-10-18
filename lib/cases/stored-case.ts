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
  return parseDiagnosticCase(stripped);
}
