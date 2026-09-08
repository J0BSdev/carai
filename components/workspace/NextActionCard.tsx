import type { ReactNode } from "react";
import type { DiagnosticStep } from "@/lib/diagnosis";
import { actionLabel } from "@/lib/diagnosis/ui-helpers";

type NextActionCardProps = {
  step: DiagnosticStep;
  stepNumber: number;
  onEnterResult: () => void;
  onCantPerform: () => void;
  onSkip: () => void;
  onHowTo: () => void;
};

export default function NextActionCard({
  step,
  stepNumber,
  onEnterResult,
  onCantPerform,
  onSkip,
  onHowTo,
}: NextActionCardProps) {
  const title =
    step.recommendedTest?.name?.trim() ||
    step.content.split(/[.\n]/)[0]?.trim() ||
    step.content;

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

        <button
          type="button"
          onClick={onEnterResult}
          className="mt-5 flex min-h-12 w-full items-center justify-center rounded-2xl bg-[var(--accent)] px-4 text-base font-semibold text-[#061018] transition active:scale-[0.99] sm:w-auto sm:min-w-[220px]"
        >
          UNESI REZULTAT
        </button>

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
