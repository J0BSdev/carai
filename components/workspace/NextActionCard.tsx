"use client";

import { useState, type ReactNode } from "react";
import type { DiagnosticStep } from "@/lib/diagnosis";
import { actionLabel } from "@/lib/diagnosis/ui-helpers";

type NextActionCardProps = {
  step: DiagnosticStep;
  stepNumber: number;
  onSubmitResult: (result: string) => void;
  onCantPerform: () => void;
  onSkip: () => void;
  onHowTo: () => void;
};

export default function NextActionCard({
  step,
  stepNumber,
  onSubmitResult,
  onCantPerform,
  onSkip,
  onHowTo,
}: NextActionCardProps) {
  const [result, setResult] = useState("");
  const title =
    step.recommendedTest?.name?.trim() ||
    step.content.split(/[.\n]/)[0]?.trim() ||
    step.content;

  function submit() {
    const trimmed = result.trim();
    if (!trimmed) return;
    onSubmitResult(trimmed);
    setResult("");
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
          {title}
        </h2>
        <p className="mt-3 text-base leading-relaxed text-[var(--muted-strong)]">
          {step.content}
        </p>

        <div className="mt-4 rounded-2xl border border-[var(--border)] bg-black/25 p-3 sm:p-4">
          <p className="text-xs font-medium tracking-wide text-[var(--muted)]">
            ZAŠTO OVAJ TEST
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-[var(--muted-strong)]">
            {step.rationale}
          </p>
        </div>

        {step.expectedResultHint && (
          <p className="mt-3 text-sm text-[var(--warning)]">
            Zabilježi: {step.expectedResultHint}
          </p>
        )}

        <div className="mt-4 flex items-end gap-2 rounded-2xl border border-[var(--border)] bg-black/25 p-2 focus-within:border-[var(--accent)]/50">
          <textarea
            value={result}
            onChange={(e) => setResult(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
            placeholder="Upiši rezultat ovdje…"
            className="min-h-[88px] flex-1 resize-y bg-transparent px-2 py-2 text-base leading-relaxed outline-none placeholder:text-[var(--muted)]"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!result.trim()}
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

        <div className="mt-3 flex flex-wrap gap-1">
          <GhostBtn onClick={onCantPerform}>Ne mogu izvesti</GhostBtn>
          <GhostBtn onClick={onSkip}>Preskoči</GhostBtn>
          <GhostBtn onClick={onHowTo}>Kako testirati?</GhostBtn>
        </div>
      </div>
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
