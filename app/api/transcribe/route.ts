import { AI_REQUEST_TIMEOUT_MS, getOpenAiApiKey } from "@/lib/diagnosis/config";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
]);

const ALLOWED_EXT = new Set([
  "webm",
  "mp4",
  "m4a",
  "ogg",
  "wav",
  "mp3",
  "mpeg",
]);

function baseMime(type: string): string {
  return type.split(";")[0]?.trim().toLowerCase() ?? "";
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

function uploadName(file: File): string {
  if (extension(file.name)) return file.name;
  const mime = baseMime(file.type);
  if (
    mime === "audio/mp4" ||
    mime === "audio/aac" ||
    mime === "audio/m4a" ||
    mime === "audio/x-m4a"
  ) {
    return "note.mp4";
  }
  if (mime === "audio/ogg") return "note.ogg";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "note.wav";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "note.mp3";
  return "note.webm";
}

function isAudioFile(value: FormDataEntryValue | null): value is File {
  return value instanceof Blob && typeof (value as File).name === "string";
}

function reject(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    return reject("Glasovni unos trenutno nije dostupan.", 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reject("Audiodatoteka nije valjana.", 400);
  }

  const file = form.get("file");
  if (!isAudioFile(file)) {
    return reject("Nedostaje audiodatoteka.", 400);
  }
  if (file.size <= 0) {
    return reject("Snimka je prazna.", 400);
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return reject("Audiodatoteka je prevelika.", 400);
  }

  const mime = baseMime(file.type);
  const ext = extension(file.name);
  const mimeOk = mime !== "" && ALLOWED_MIME.has(mime);
  const extOk = ALLOWED_EXT.has(ext);
  if (mime ? !mimeOk : !extOk) {
    return reject("Format audiodatoteke nije podržan.", 400);
  }

  const outbound = new FormData();
  outbound.append("file", file, uploadName(file));
  outbound.append("model", "gpt-4o-transcribe");
  outbound.append("language", "hr");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: outbound,
      signal: controller.signal,
    });
  } catch {
    return reject("Transkripcija nije uspjela.", 502);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    console.error("[transcribe]", response.status, errText.slice(0, 300));
    return reject("Transkripcija nije uspjela.", 502);
  }

  const data = (await response.json()) as { text?: unknown };
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) {
    return reject("Transkript je prazan.", 422);
  }
  return Response.json({ text });
}
