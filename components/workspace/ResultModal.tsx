"use client";

import { useMemo, useState } from "react";
import type { DiagnosticStep } from "@/lib/diagnosis";
import {
  inferUnit,
  looksNumericTest,
  needsDualMeasurement,
} from "@/lib/diagnosis/ui-helpers";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type ResultModalProps = {
  open: boolean;
  onClose: () => void;
  step: DiagnosticStep;
  onSubmit: (result: string) => void;
};

export default function ResultModal({
  open,
  onClose,
  step,
  onSubmit,
}: ResultModalProps) {
  const [text, setText] = useState("");
  const [measure, setMeasure] = useState("");
  const [measure2, setMeasure2] = useState("");
  const numeric = looksNumericTest(step);
  const dual = needsDualMeasurement(step);
  const unit = inferUnit(step);

  const title =
    step.recommendedTest?.name?.trim() ||
    step.content.split(/[.\n]/)[0]?.trim() ||
    "Rezultat testa";

  const quick = useMemo(() => {
    if (step.actionType === "ASK") {
      return ["Da", "Ne", "Nisam siguran"];
    }
    if (numeric) return [];
    return ["Uobičajeno", "Neuobičajeno", "Nisam mogao utvrditi"];
  }, [step.actionType, numeric]);

  function reset() {
    setText("");
    setMeasure("");
    setMeasure2("");
  }

  function handleClose() {
    reset();
    onClose();
  }

  function buildPayload(extra?: string): string | null {
    if (extra) return extra;
    if (numeric) {
      if (!measure.trim() || (dual && !measure2.trim())) return null;
      if (dual) {
        return `prije: ${measure.trim()}${unit ? ` ${unit}` : ""} · poslije: ${measure2.trim()}${unit ? ` ${unit}` : ""}${
          text.trim() ? ` · napomena: ${text.trim()}` : ""
        }`;
      }
      return `${measure.trim()}${unit ? ` ${unit}` : ""}${
        text.trim() ? ` · napomena: ${text.trim()}` : ""
      }`;
    }
    return text.trim() || null;
  }

  function submit(extra?: string) {
    const payload = buildPayload(extra);
    if (!payload) return;
    onSubmit(payload);
    reset();
  }

  return (
    <ResponsiveOverlay open={open} onClose={handleClose} title="Rezultat testa">
      <p className="text-sm text-[var(--muted-strong)]">{title}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">Što si pronašao?</p>

      {numeric ? (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <MeasureField
            label={dual ? "Prije" : "Vrijednost"}
            value={measure}
            onChange={setMeasure}
            unit={unit}
          />
          {dual && (
            <MeasureField
              label="Poslije"
              value={measure2}
              onChange={setMeasure2}
              unit={unit}
            />
          )}
        </div>
      ) : null}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="mt-4 w-full resize-y rounded-2xl border border-[var(--border)] bg-black/25 px-3 py-3 text-base outline-none focus:border-[var(--accent)]"
        placeholder={
          numeric
            ? "Opcionalna napomena…"
            : "Opiši rezultat ili što si primijetio…"
        }
      />

      {quick.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium tracking-wide text-[var(--muted)]">
            BRZI REZULTATI
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {quick.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => submit(q)}
                className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--muted-strong)] transition hover:border-[var(--accent)]/40 hover:text-[var(--foreground)]"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          disabled
          className="min-h-11 rounded-xl border border-dashed border-[var(--border)] px-3 text-left text-sm text-[var(--muted)]"
        >
          + Dodaj mjerenje (uskoro)
        </button>
        <button
          type="button"
          disabled
          className="min-h-11 rounded-xl border border-dashed border-[var(--border)] px-3 text-left text-sm text-[var(--muted)]"
        >
          + Dodaj fotografiju (uskoro)
        </button>
      </div>

      <button
        type="button"
        onClick={() => submit()}
        disabled={!buildPayload()}
        className="mt-5 flex min-h-12 w-full items-center justify-center rounded-2xl bg-[var(--accent)] text-base font-semibold text-[#061018] disabled:opacity-35"
      >
        POŠALJI REZULTAT →
      </button>
    </ResponsiveOverlay>
  );
}

function MeasureField({
  label,
  value,
  onChange,
  unit,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <div className="flex min-h-12 overflow-hidden rounded-2xl border border-[var(--border)] bg-black/25 focus-within:border-[var(--accent)]">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mono-data min-w-0 flex-1 bg-transparent px-3 text-lg outline-none"
          placeholder="0"
        />
        {unit && (
          <span className="mono-data flex items-center border-l border-[var(--border)] px-3 text-sm text-[var(--muted)]">
            {unit}
          </span>
        )}
      </div>
    </label>
  );
}
