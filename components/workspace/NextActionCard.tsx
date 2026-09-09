"use client";

import { useState, type ReactNode } from "react";
import type { DiagnosticStep } from "@/lib/diagnosis";
import { actionLabel } from "@/lib/diagnosis/ui-helpers";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type NextActionCardProps = {
  step: DiagnosticStep;
  stepNumber: number;
  onSubmitResult: (result: string) => void;
  onCantPerform: () => void;
  onSkip: () => void;
  onHowTo: () => void;
};

function shortTitle(step: DiagnosticStep): string {
  const named = step.recommendedTest?.name?.trim();
  if (named) return named.length > 72 ? `${named.slice(0, 69).trimEnd()}…` : named;

  const first =
    step.content.split(/[.\n!?]/)[0]?.trim() || step.content.trim();
  if (first.length <= 72) return first;
  return `${first.slice(0, 69).trimEnd()}…`;
}

/** 1–2 short sentences of content that do not repeat the title. */
function shortDescription(step: DiagnosticStep, title: string): string {
  const raw = step.content.replace(/\s+/g, " ").trim();
  if (!raw) return "";

  const titleNorm = title.replace(/…$/, "").trim().toLowerCase();
  let body = raw;

  // Drop a leading sentence that is essentially the title
  const sentences = raw
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length > 1) {
    const firstNorm = sentences[0]!.replace(/[.!?]+$/, "").trim().toLowerCase();
    if (
      firstNorm === titleNorm ||
      firstNorm.startsWith(titleNorm) ||
      titleNorm.startsWith(firstNorm)
    ) {
      body = sentences.slice(1).join(" ");
    }
  } else if (
    raw.replace(/[.!?]+$/, "").trim().toLowerCase() === titleNorm
  ) {
    return "";
  }

  const kept = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);

  return kept.join(" ");
}

export default function NextActionCard({
  step,
  stepNumber,
  onSubmitResult,
  onCantPerform,
  onSkip,
  onHowTo,
}: NextActionCardProps) {
  const [result, setResult] = useState("");
  const [whyOpen, setWhyOpen] = useState(false);
  const title = shortTitle(step);
  const description = shortDescription(step, title);
  const whyLabel =
    step.actionType === "ASK" ? "Zašto ovo pitanje?" : "Zašto ovaj test?";

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
        {description ? (
          <p className="mt-2 text-base leading-relaxed text-[var(--muted-strong)]">
            {description}
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
