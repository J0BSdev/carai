"use client";

import { useMemo, useState } from "react";
import type { DiagnosticCase } from "@/lib/diagnosis";
import { extractFactsFromText } from "@/lib/diagnosis/known-facts";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type VehicleHeaderProps = {
  diagnosticCase: DiagnosticCase;
  elapsedLabel: string;
  statusLabel: string;
};

function shortComplaint(text: string, max = 110): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

export default function VehicleHeader({
  diagnosticCase,
  elapsedLabel,
  statusLabel,
}: VehicleHeaderProps) {
  const [open, setOpen] = useState(false);

  const { vehicle: v, dtcs, complaint } = useMemo(() => {
    const fromText = extractFactsFromText(diagnosticCase.problemText);
    const stored = diagnosticCase.extracted;
    const vehicle = {
      make: stored?.vehicle?.make || fromText.vehicle?.make,
      model: stored?.vehicle?.model || fromText.vehicle?.model,
      year: stored?.vehicle?.year ?? fromText.vehicle?.year,
      engine: stored?.vehicle?.engine || fromText.vehicle?.engine,
      mileage: stored?.vehicle?.mileage ?? fromText.vehicle?.mileage,
    };
    const codeSet = new Set<string>([
      ...(stored?.dtcs ?? []),
      ...(fromText.dtcs ?? []),
    ]);
    return {
      vehicle,
      dtcs: [...codeSet],
      complaint: shortComplaint(diagnosticCase.problemText),
    };
  }, [diagnosticCase]);

  const make = v.make?.trim();
  const model = v.model?.trim();
  const title =
    [make, model].filter(Boolean).join(" ") ||
    (make ?? "Vozilo");

  const metaLine = [v.year, v.engine, elapsedLabel].filter(Boolean).join(" · ");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="surface-2 anim-in flex w-full items-start justify-between gap-3 p-4 text-left transition hover:border-[var(--border-strong)]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <h1 className="min-w-0 break-words text-lg font-semibold tracking-tight sm:text-xl">
              {title}
            </h1>
            <span className="shrink-0 rounded-full border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--accent)]">
              AKTIVAN SLUČAJ
            </span>
          </div>
          {metaLine && (
            <p className="mt-1 truncate text-sm text-[var(--muted)]">{metaLine}</p>
          )}
          <p className="mt-3 text-xs text-[var(--muted)]">Prijavljeni kvar</p>
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-[var(--muted-strong)]">
            {complaint}
          </p>
          {(dtcs.length > 0 || statusLabel) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {dtcs.map((d) => (
                <span
                  key={d}
                  className="mono-data rounded-lg border border-[var(--border)] bg-black/20 px-2 py-1 text-xs text-[var(--accent-2)]"
                >
                  {d}
                </span>
              ))}
              {statusLabel ? (
                <span className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)]">
                  {statusLabel}
                </span>
              ) : null}
            </div>
          )}
        </div>
        <span className="shrink-0 text-[var(--muted)]" aria-hidden>
          •••
        </span>
      </button>

      <ResponsiveOverlay
        open={open}
        onClose={() => setOpen(false)}
        title="Detalji vozila"
      >
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Field label="Marka" value={v.make} />
          <Field label="Model" value={v.model} />
          <Field label="Godina" value={v.year?.toString()} />
          <Field label="Motor" value={v.engine} />
          <Field
            label="Kilometraža"
            value={v.mileage ? `${v.mileage} km` : undefined}
          />
          <Field
            label="DTC"
            value={dtcs.length ? dtcs.join(", ") : undefined}
            mono
          />
          <div className="sm:col-span-2">
            <Field label="Prijavljeni kvar" value={complaint} />
          </div>
        </dl>
      </ResponsiveOverlay>
    </>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  if (!value?.trim()) return null;
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd
        className={`mt-1 text-[var(--foreground)] ${mono ? "mono-data" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
