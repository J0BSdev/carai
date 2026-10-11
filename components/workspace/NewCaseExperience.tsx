"use client";

import { useEffect, useRef, useState } from "react";
import VoiceNote from "@/components/workspace/VoiceNote";

type NewCaseExperienceProps = {
  value: string;
  onChange: (v: string) => void;
  onStart: () => void;
  loading: boolean;
  error: string | null;
};

export default function NewCaseExperience({
  value,
  onChange,
  onStart,
  loading,
  error,
}: NewCaseExperienceProps) {
  const [voiceBusy, setVoiceBusy] = useState(false);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-10 sm:px-6">
      <div className="anim-in">
        <p className="text-sm font-semibold tracking-[0.18em] text-[var(--accent)]">
          CARAI
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          Pokreni dijagnozu
        </h1>
        <p className="mt-3 text-lg text-[var(--muted-strong)]">
          Što se događa s vozilom?
        </p>

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]"
          >
            {error}
          </p>
        )}

        <div className="surface-3 mt-8 rounded-[var(--radius-lg)] p-3">
          <textarea
            value={value}
            onChange={(e) => {
              valueRef.current = e.target.value;
              onChange(e.target.value);
            }}
            rows={5}
            disabled={loading}
            placeholder="Opišite problem što detaljnije možete…"
            className="min-h-36 w-full resize-y bg-transparent px-2 py-2 text-base leading-relaxed outline-none placeholder:text-[var(--muted)]"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 text-[var(--muted)]">
              <VoiceNote
                disabled={loading}
                onBusyChange={setVoiceBusy}
                onTranscript={(text) => {
                  const prev = valueRef.current.trim();
                  const next = prev ? `${prev}\n${text}` : text;
                  valueRef.current = next;
                  onChange(next);
                }}
              />
              <span
                className="flex h-10 w-10 items-center justify-center opacity-50"
                title="Kamera uskoro"
              >
                <CameraIcon />
              </span>
            </div>
            <button
              type="button"
              onClick={onStart}
              disabled={loading || voiceBusy || !value.trim()}
              aria-label="Pokreni"
              className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-[#061018] disabled:opacity-35"
            >
              <ArrowIcon />
            </button>
          </div>
        </div>

        <p className="mt-3 text-sm text-[var(--muted)]">
          Piši prirodno.
        </p>

        <div className="mt-8 flex flex-wrap gap-2">
          <FutureChip>VIN sken — uskoro</FutureChip>
          <FutureChip>VIN unos — uskoro</FutureChip>
          <FutureChip>OBD spoj — uskoro</FutureChip>
        </div>
      </div>
    </section>
  );
}

function FutureChip({ children }: { children: string }) {
  return (
    <button
      type="button"
      disabled
      className="min-h-11 rounded-xl border border-dashed border-[var(--border)] px-3 text-sm text-[var(--muted)]"
    >
      {children}
    </button>
  );
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 8h3l2-2h6l2 2h3v11H4V8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
