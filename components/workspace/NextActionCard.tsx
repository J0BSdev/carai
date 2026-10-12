"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DiagnosticStep, TurnImage } from "@/lib/diagnosis";
import { fileToTurnImage } from "@/lib/diagnosis/turn-image";
import { actionLabel } from "@/lib/diagnosis/ui-helpers";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";
import PhotoAttach from "@/components/workspace/PhotoAttach";
import VoiceNote from "@/components/workspace/VoiceNote";

type NextActionCardProps = {
  step: DiagnosticStep;
  stepNumber: number;
  onSubmitResult: (result: string, image?: TurnImage) => void;
  onCantPerform: () => void;
  onSkip: () => void;
  onHowTo: () => void;
  pending?: boolean;
};

export default function NextActionCard({
  step,
  stepNumber,
  onSubmitResult,
  onCantPerform,
  onSkip,
  onHowTo,
  pending = false,
}: NextActionCardProps) {
  const [result, setResult] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [hasPhoto, setHasPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const photoRef = useRef<File | null>(null);
  const photoGen = useRef(0);
  const preparingRef = useRef(false);
  const stepIdRef = useRef(step.id);
  useLayoutEffect(() => {
    stepIdRef.current = step.id;
    return () => {
      if (stepIdRef.current === step.id) stepIdRef.current = "";
    };
  }, [step.id]);
  const onPhoto = useCallback((file: File | null) => {
    photoGen.current += 1;
    photoRef.current = file;
    setHasPhoto(file != null);
    if (file) setPhotoError(null);
  }, []);
  const [photoStepId, setPhotoStepId] = useState(step.id);
  if (photoStepId !== step.id) {
    setPhotoStepId(step.id);
    setPhotoError(null);
    setHasPhoto(false);
  }

  useEffect(() => {
    setResult("");
  }, [step.id]);
  const title = step.title?.trim();
  const whyLabel =
    step.actionType === "ASK" ? "Zašto ovo pitanje?" : "Zašto ovaj test?";

  async function submit() {
    if (voiceBusy || pending || preparingRef.current) return;
    const trimmed = result.trim();
    const file = photoRef.current;
    if (!trimmed && !file) return;
    const gen = photoGen.current;
    const stepAtStart = step.id;
    preparingRef.current = true;
    setPreparing(true);
    try {
      const image = file ? await fileToTurnImage(file) : undefined;
      if (
        stepIdRef.current !== stepAtStart ||
        photoGen.current !== gen ||
        photoRef.current !== file
      ) {
        return;
      }
      setPhotoError(null);
      onSubmitResult(trimmed, image);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Slika nije valjana.");
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }

  return (
    <section className="hero-card anim-in relative p-4 sm:p-6">
      <div className="relative z-10">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs font-semibold tracking-[0.16em] text-[var(--accent)]">
            SLJEDEĆI DIJAGNOSTIČKI KORAK
          </p>
          <p className="mono-data text-xs text-[var(--muted)]">
            {String(stepNumber).padStart(2, "0")}
          </p>
        </div>
        <p className="mt-2 text-[11px] tracking-wide text-[var(--muted)]">
          {actionLabel(step.actionType)}
        </p>
        <h2 className="mt-3 text-xl font-semibold leading-snug tracking-tight sm:text-2xl">
          {title || step.content}
        </h2>
        {title ? (
          <p className="mt-2 text-base leading-relaxed text-[var(--muted-strong)]">
            {step.content}
          </p>
        ) : null}

        {step.rationale?.trim() ? (
          <button
            type="button"
            onClick={() => setWhyOpen(true)}
            className="mt-2 text-sm font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Zašto?
          </button>
        ) : null}

        {step.expectedResultHint && (
          <p className="mt-3 text-sm text-[var(--warning)]">
            Zabilježi: {step.expectedResultHint}
          </p>
        )}

        <div className="mt-4 rounded-2xl border border-[var(--border)] bg-black/25 p-2 focus-within:border-[var(--accent)]/50">
          <div className="flex items-end gap-2">
            <textarea
              value={result}
              onChange={(e) => setResult(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={3}
              placeholder="Upiši rezultat ovdje…"
              className="min-h-[88px] flex-1 resize-y bg-transparent px-2 py-2 text-base leading-relaxed outline-none placeholder:text-[var(--muted)]"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={
                voiceBusy ||
                pending ||
                preparing ||
                (!result.trim() && !hasPhoto)
              }
              aria-label="Pošalji rezultat"
              className="mb-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-[#061018] transition active:scale-95 disabled:opacity-35"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M5 12h14M13 6l6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          <div className="flex flex-wrap items-start gap-1">
            <VoiceNote
              key={`${step.id}-voice`}
              onBusyChange={setVoiceBusy}
              onTranscript={(text) => {
                setResult((current) => {
                  const prev = current.trim();
                  return prev ? `${prev}\n${text}` : text;
                });
              }}
            />
            <PhotoAttach key={`${step.id}-photo`} onChange={onPhoto} />
          </div>
          {photoError ? (
            <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
              {photoError}
            </p>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {step.actionType === "TEST" ? (
            <GhostBtn onClick={onCantPerform}>Ne mogu izvesti</GhostBtn>
          ) : null}
          <GhostBtn onClick={onSkip}>Preskoči</GhostBtn>
          {step.actionType === "TEST" ? (
            <GhostBtn onClick={onHowTo}>Kako testirati?</GhostBtn>
          ) : null}
        </div>
      </div>

      <ResponsiveOverlay
        open={whyOpen}
        onClose={() => setWhyOpen(false)}
        title={whyLabel}
      >
        <p className="text-sm leading-relaxed text-[var(--muted-strong)] whitespace-pre-wrap">
          {step.rationale}
        </p>
      </ResponsiveOverlay>
    </section>
  );
}

function GhostBtn({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 rounded-xl px-3 text-sm text-[var(--muted-strong)] transition hover:bg-white/5 hover:text-[var(--foreground)]"
    >
      {children}
    </button>
  );
}
