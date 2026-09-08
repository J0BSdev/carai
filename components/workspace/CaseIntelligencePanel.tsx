"use client";

import type { DiagnosticCase, Hypothesis } from "@/lib/diagnosis";
import type { DiagnosticPhaseUi } from "@/lib/diagnosis/ui-helpers";

type CaseIntelligencePanelProps = {
  diagnosticCase: DiagnosticCase;
  statusLabel: DiagnosticPhaseUi;
  hypotheses: Hypothesis[];
  onViewHypotheses: () => void;
};

export default function CaseIntelligencePanel({
  diagnosticCase,
  statusLabel,
  hypotheses,
  onViewHypotheses,
}: CaseIntelligencePanelProps) {
  const tests = diagnosticCase.steps.filter((s) => s.actionType === "TEST").length;
  const asks = diagnosticCase.steps.filter((s) => s.actionType === "ASK").length;
  const measurements = diagnosticCase.observations.length;
  const leading =
    hypotheses.find((h) => h.status === "supported") ??
    hypotheses.find((h) => h.status === "plausible");

  return (
    <aside className="surface-2 anim-in hidden h-fit p-4 lg:block">
      <p className="text-xs font-semibold tracking-[0.14em] text-[var(--muted)]">
        INTELIGENCIJA SLUČAJA
      </p>
      <p className="mt-3 text-sm font-medium text-[var(--accent)]">{statusLabel}</p>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Stat label="Opažanja" value={asks + measurements} />
        <Stat label="Testovi" value={tests} />
        <Stat label="Unosi" value={measurements} />
      </div>

      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <p className="text-xs text-[var(--muted)]">Trenutni smjer</p>
        <p className="mt-1 text-sm leading-snug text-[var(--muted-strong)]">
          {leading?.label ?? "Još se formira"}
        </p>
      </div>

      <button
        type="button"
        onClick={onViewHypotheses}
        className="mt-4 flex min-h-11 w-full items-center justify-center rounded-xl border border-[var(--border)] text-sm text-[var(--muted-strong)] transition hover:bg-white/5"
      >
        Pregledaj hipoteze
      </button>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-black/20 px-2 py-3">
      <p className="mono-data text-lg font-medium">{value}</p>
      <p className="text-[10px] text-[var(--muted)]">{label}</p>
    </div>
  );
}
