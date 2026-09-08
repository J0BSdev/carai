"use client";

import { useState } from "react";
import type { Hypothesis } from "@/lib/diagnosis";
import {
  evidenceBadgeMeta,
  hypothesisToKind,
} from "@/lib/diagnosis/ui-helpers";

type HypothesesPanelProps = {
  hypotheses: Hypothesis[];
};

export default function HypothesesPanel({ hypotheses }: HypothesesPanelProps) {
  const [open, setOpen] = useState(false);
  if (hypotheses.length === 0) return null;

  const leading = hypotheses.filter(
    (h) => h.status === "supported" || h.status === "plausible",
  );
  const alternatives = hypotheses.filter(
    (h) => h.status === "weakened" || h.status === "ruled_out",
  );

  return (
    <section className="surface-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-[var(--surface-hover)]"
        aria-expanded={open}
      >
        <span className="text-sm text-[var(--muted-strong)]">
          Trenutni dijagnostički smjer
        </span>
        <span className="text-xs text-[var(--muted)]">
          {open ? "Sakrij" : "Prikaži"}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-4 py-3">
          {leading.length > 0 && (
            <div className="mb-3">
              <p className="mb-2 text-xs text-[var(--muted)]">Glavni smjer</p>
              <ul className="flex flex-col gap-2">
                {leading.map((h) => {
                  const meta = evidenceBadgeMeta(hypothesisToKind(h.status));
                  return (
                    <li key={h.label} className="flex flex-wrap items-start gap-2">
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-medium ${meta.className}`}
                      >
                        {meta.label}
                      </span>
                      <span className="text-sm text-[var(--foreground)]">
                        {h.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {alternatives.length > 0 && (
            <div>
              <p className="mb-2 text-xs text-[var(--muted)]">
                Alternative u razmatranju
              </p>
              <ul className="flex flex-col gap-2">
                {alternatives.map((h) => {
                  const meta = evidenceBadgeMeta(hypothesisToKind(h.status));
                  return (
                    <li key={h.label} className="flex flex-wrap items-start gap-2">
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-medium ${meta.className}`}
                      >
                        {meta.label}
                      </span>
                      <span className="text-sm text-[var(--muted-strong)]">
                        {h.label}
                        {h.note ? ` — ${h.note}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
