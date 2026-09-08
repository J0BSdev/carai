import type { DiagnosticPhaseUi } from "@/lib/diagnosis/ui-helpers";

type DiagnosticStatusProps = {
  label: DiagnosticPhaseUi;
  progressIndex: number;
  progressTotal: number;
};

export default function DiagnosticStatus({
  label,
  progressIndex,
  progressTotal,
}: DiagnosticStatusProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-full border border-[var(--border-strong)] bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-semibold tracking-wide text-[var(--accent)]">
          {label}
        </span>
        <span className="text-xs text-[var(--muted)]">
          Faza {progressIndex}/{progressTotal}
        </span>
      </div>
      <div
        className="flex gap-1.5"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={progressTotal}
        aria-valuenow={progressIndex}
        aria-label={label}
      >
        {Array.from({ length: progressTotal }).map((_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
              i < progressIndex
                ? "bg-[var(--accent)]"
                : "bg-[rgba(255,255,255,0.08)]"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
