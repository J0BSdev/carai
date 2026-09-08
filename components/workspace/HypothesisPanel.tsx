"use client";

import type { Hypothesis } from "@/lib/diagnosis";
import {
  evidenceBadgeMeta,
  hypothesisToKind,
} from "@/lib/diagnosis/ui-helpers";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type HypothesisPanelProps = {
  open: boolean;
  onClose: () => void;
  hypotheses: Hypothesis[];
  evidenceNeeded?: string;
};

export default function HypothesisPanel({
  open,
  onClose,
  hypotheses,
  evidenceNeeded,
}: HypothesisPanelProps) {
  const leading = hypotheses.filter(
    (h) => h.status === "supported" || h.status === "plausible",
  );
  const alternatives = hypotheses.filter(
    (h) => h.status === "weakened" || h.status === "ruled_out",
  );

  return (
    <ResponsiveOverlay open={open} onClose={onClose} title="Dijagnostičke hipoteze">
      {hypotheses.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          Još nema strukturiranih hipoteza u ovom odgovoru.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {leading.length > 0 && (
            <section>
              <p className="text-xs font-semibold tracking-wide text-[var(--accent)]">
                GLAVNI SMJER
              </p>
              <ul className="mt-2 flex flex-col gap-3">
                {leading.map((h) => (
                  <HypothesisRow key={h.label} h={h} />
                ))}
              </ul>
            </section>
          )}
          {alternatives.length > 0 && (
            <section>
              <p className="text-xs font-semibold tracking-wide text-[var(--muted)]">
                ALTERNATIVE
              </p>
              <ul className="mt-2 flex flex-col gap-3">
                {alternatives.map((h) => (
                  <HypothesisRow key={h.label} h={h} />
                ))}
              </ul>
            </section>
          )}
          <section className="rounded-2xl border border-[var(--border)] bg-black/20 p-3">
            <p className="text-xs text-[var(--muted)]">Još potrebni dokazi</p>
            <p className="mt-1 text-sm text-[var(--muted-strong)]">
              {evidenceNeeded ||
                "AI će predložiti sljedeći test koji najviše sužava smjer."}
            </p>
          </section>
        </div>
      )}
    </ResponsiveOverlay>
  );
}

function HypothesisRow({ h }: { h: Hypothesis }) {
  const meta = evidenceBadgeMeta(hypothesisToKind(h.status));
  return (
    <li className="rounded-2xl border border-[var(--border)] p-3">
      <span className={`rounded border px-2 py-0.5 text-[10px] ${meta.className}`}>
        {meta.label}
      </span>
      <p className="mt-2 text-sm font-medium">{h.label}</p>
      {h.note && <p className="mt-1 text-xs text-[var(--muted)]">{h.note}</p>}
    </li>
  );
}
