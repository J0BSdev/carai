import type { TurnImage } from "./types";

/** Claude and the server accept at most this many bytes. Larger photos are scaled first. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MAX_EDGE = 8000;
const MIN_EDGE = 1600;

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function renderJpeg(
  bitmap: ImageBitmap,
  edge: number,
  quality: number,
): Promise<Blob> {
  const scale = edge / Math.max(bitmap.width, bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Slika nije valjana.");
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Slika nije valjana."))),
      "image/jpeg",
      quality,
    );
  });
}

/** Shrink only until the JPEG fits. Quality stays high so small text remains readable. */
async function jpegWithinLimit(bitmap: ImageBitmap): Promise<TurnImage> {
  let edge = Math.min(MAX_EDGE, Math.max(bitmap.width, bitmap.height));
  let blob = await renderJpeg(bitmap, edge, 0.92);
  while (blob.size > MAX_IMAGE_BYTES && edge > MIN_EDGE) {
    edge = Math.max(MIN_EDGE, Math.round(edge * 0.8));
    blob = await renderJpeg(bitmap, edge, 0.92);
    if (edge === MIN_EDGE) break;
  }
  if (blob.size > MAX_IMAGE_BYTES) blob = await renderJpeg(bitmap, edge, 0.8);
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("Slika je prevelika.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { mediaType: "image/jpeg", data: bytesToBase64(bytes) };
}

export async function fileToTurnImage(file: File): Promise<TurnImage> {
  if (file.size <= 0) throw new Error("Slika je prazna.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Podržane su samo JPEG, PNG i WebP slike.");
  }
  try {
    const withinEdge = Math.max(bitmap.width, bitmap.height) <= MAX_EDGE;
    if (withinEdge && file.size <= MAX_IMAGE_BYTES) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mediaType = imageMediaType(bytes);
      if (mediaType) return { mediaType, data: bytesToBase64(bytes) };
    }
    return await jpegWithinLimit(bitmap);
  } finally {
    bitmap.close();
  }
}
