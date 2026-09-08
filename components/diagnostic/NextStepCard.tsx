import type { DiagnosticStep } from "@/lib/diagnosis";
import { actionLabel } from "@/lib/diagnosis/ui-helpers";

type NextStepCardProps = {
  step: DiagnosticStep;
  stepNumber: number;
  onEnterResult: () => void;
  onCantPerform: () => void;
  onSkip: () => void;
};

export default function NextStepCard({
  step,
  stepNumber,
  onEnterResult,
  onCantPerform,
  onSkip,
}: NextStepCardProps) {
  const title =
    step.recommendedTest?.name?.trim() ||
    step.content.split(/[.\n]/)[0]?.trim() ||
    step.content;

  return (
    <section className="surface-card-strong anim-enter p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold tracking-[0.16em] text-[var(--accent)]">
          SLJEDEĆI KORAK
        </p>
        <p className="text-xs text-[var(--muted)]">KORAK {stepNumber}</p>
      </div>

      <p className="mt-1 text-[11px] font-medium tracking-wide text-[var(--muted)]">
        {actionLabel(step.actionType)}
      </p>

      <h2 className="mt-3 text-xl font-semibold leading-snug tracking-tight text-[var(--foreground)] sm:text-2xl">
        {title}
      </h2>

      <p className="mt-3 text-base leading-relaxed text-[var(--muted-strong)]">
        {step.content}
      </p>

      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[rgba(0,0,0,0.2)] p-3">
        <p className="text-xs font-medium tracking-wide text-[var(--muted)]">
          ZAŠTO OVO?
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--muted-strong)]">
          {step.rationale}
        </p>
      </div>

      {step.expectedResultHint && (
        <p className="mt-3 text-sm text-[var(--amber)]">
          Zabilježi: {step.expectedResultHint}
        </p>
      )}

      <p className="mt-3 text-xs text-[var(--muted)]">
        Procjena: ~3 min · Radionički test
      </p>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={onEnterResult}
          className="min-h-12 flex-1 rounded-xl bg-[var(--accent)] px-4 text-base font-semibold text-[#071018] transition active:scale-[0.99] sm:flex-none sm:px-6"
        >
          Unesi rezultat
        </button>
        <button
          type="button"
          onClick={onCantPerform}
          className="min-h-11 rounded-xl px-3 text-sm text-[var(--muted-strong)] transition hover:text-[var(--foreground)]"
        >
          Ne mogu izvesti ovaj test
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="min-h-11 rounded-xl px-3 text-sm text-[var(--muted)] transition hover:text-[var(--muted-strong)]"
        >
          Preskoči
        </button>
      </div>
    </section>
  );
}
