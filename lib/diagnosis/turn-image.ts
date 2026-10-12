import type { TurnImage } from "./types";

/** Claude accepts the original file up to this size. Larger files are rejected, not resized. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export function imageMediaType(
  bytes: Uint8Array,
): TurnImage["mediaType"] | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function parseTurnImage(value: unknown): TurnImage | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Slika nije valjana.");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "mediaType" && key !== "data") {
      throw new Error("Slika nije valjana.");
    }
  }
  if (typeof raw.data !== "string" || raw.data.length === 0) {
    throw new Error("Slika nije valjana.");
  }
  if (raw.data.length > MAX_BASE64_CHARS) {
    throw new Error("Slika je prevelika.");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw.data)) {
    throw new Error("Slika nije valjana.");
  }

  let bytes: Uint8Array;
  try {
    const binary = atob(raw.data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
  } catch {
    throw new Error("Slika nije valjana.");
  }

  if (bytes.byteLength === 0) throw new Error("Slika je prazna.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Slika je prevelika.");
  const sniffed = imageMediaType(bytes);
  if (!sniffed || raw.mediaType !== sniffed) {
    throw new Error("Podržane su samo JPEG, PNG i WebP slike.");
  }
  return { mediaType: sniffed, data: raw.data };
}

export async function fileToTurnImage(file: File): Promise<TurnImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Slika je prazna.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Slika je prevelika.");
  const mediaType = imageMediaType(bytes);
  if (!mediaType) throw new Error("Podržane su samo JPEG, PNG i WebP slike.");

  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { mediaType, data: btoa(binary) };
}
