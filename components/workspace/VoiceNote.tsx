"use client";

import { useEffect, useRef, useState } from "react";

const MAX_SECONDS = 180;

type VoiceNoteProps = {
  disabled?: boolean;
  onTranscript: (text: string) => void;
};

function clock(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function fileName(type: string): string {
  const mime = type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "audio/mp4" || mime === "audio/aac" || mime === "audio/m4a") {
    return "note.mp4";
  }
  if (mime === "audio/ogg") return "note.ogg";
  if (mime === "audio/wav") return "note.wav";
  return "note.webm";
}

function preferredMime(): string {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export default function VoiceNote({ disabled, onTranscript }: VoiceNoteProps) {
  const [phase, setPhase] = useState<
    "idle" | "recording" | "ready" | "transcribing"
  >("idle");
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const startingRef = useRef(false);

  function clearTimer() {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function stopStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function revokeUrl() {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setAudioUrl(null);
  }

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimer();
      abortRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      recorderRef.current = null;
      stopStream();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  function discardClip() {
    abortRef.current?.abort();
    abortRef.current = null;
    blobRef.current = null;
    revokeUrl();
    setSeconds(0);
  }

  async function start() {
    if (disabled || startingRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        setError("Ovaj preglednik ne podržava snimanje.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mime = preferredMime();
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopStream();
        clearTimer();
        const type = recorder.mimeType || mime || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        recorderRef.current = null;
        if (!aliveRef.current) return;
        if (blob.size === 0) {
          setPhase("idle");
          setError("Snimka je prazna.");
          return;
        }
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setAudioUrl(url);
        setPhase("ready");
      };
      recorderRef.current = recorder;
      recorder.start(250);
      const startedAt = Date.now();
      setSeconds(0);
      setPhase("recording");
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) {
          const active = recorderRef.current;
          if (active && active.state !== "inactive") active.stop();
        }
      }, 250);
    } catch (err) {
      stopStream();
      const name = err instanceof DOMException ? err.name : "";
      if (!aliveRef.current) return;
      setPhase("idle");
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setError("Dozvola za mikrofon je odbijena.");
      } else {
        setError("Mikrofon nije dostupan.");
      }
    } finally {
      startingRef.current = false;
    }
  }

  function stop() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  function remove() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    recorderRef.current = null;
    clearTimer();
    stopStream();
    discardClip();
    setPhase("idle");
    setError(null);
  }

  async function transcribe() {
    const blob = blobRef.current;
    if (!blob || phase === "transcribing") return;
    setError(null);
    setPhase("transcribing");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const body = new FormData();
      body.append("file", blob, fileName(blob.type));
      const response = await fetch("/api/transcribe", {
        method: "POST",
        body,
        signal: controller.signal,
      });
      let data: { error?: unknown; text?: unknown };
      try {
        data = (await response.json()) as { error?: unknown; text?: unknown };
      } catch {
        throw new Error("Transkripcija nije uspjela.");
      }
      if (!response.ok) {
        const message =
          typeof data.error === "string"
            ? data.error
            : "Transkripcija nije uspjela.";
        throw new Error(message);
      }
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) throw new Error("Transkript je prazan.");
      if (!aliveRef.current || controller.signal.aborted) return;
      onTranscript(text);
      setPhase("ready");
    } catch (err) {
      if (!aliveRef.current || controller.signal.aborted) return;
      setPhase("ready");
      setError(
        err instanceof Error ? err.message : "Transkripcija nije uspjela.",
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  return (
    <div className="min-w-0">
      {phase === "idle" ? (
        <button
          type="button"
          onClick={() => void start()}
          aria-label="Snimi opis"
          disabled={disabled}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted)] transition hover:bg-white/5 hover:text-[var(--foreground)] disabled:opacity-35"
        >
          <MicIcon />
        </button>
      ) : null}

      {phase === "recording" ? (
        <div className="flex items-center gap-3">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--danger)]"
            aria-hidden
          />
          <span className="mono-data text-sm text-[var(--foreground)]">
            {clock(seconds)}
          </span>
          <button
            type="button"
            onClick={stop}
            className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--foreground)]"
          >
            Zaustavi
          </button>
        </div>
      ) : null}

      {phase === "ready" || phase === "transcribing" ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {audioUrl ? (
            <audio src={audioUrl} controls preload="metadata" className="h-11 w-full min-w-0 sm:flex-1" />
          ) : null}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={remove}
              className="min-h-11 rounded-xl px-3 text-sm text-[var(--muted-strong)] transition hover:bg-white/5 hover:text-[var(--foreground)]"
            >
              Obriši
            </button>
            <button
              type="button"
              onClick={() => void transcribe()}
              disabled={phase === "transcribing"}
              className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--foreground)] disabled:opacity-35"
            >
              {phase === "transcribing" ? "Prepisujem…" : "Prepiši"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
