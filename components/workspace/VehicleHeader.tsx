"use client";

import { useState } from "react";
import type { DiagnosticCase } from "@/lib/diagnosis";
import {
  vehicleMake,
  vehicleSubtitle,
} from "@/lib/diagnosis/ui-helpers";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type VehicleHeaderProps = {
  diagnosticCase: DiagnosticCase;
  elapsedLabel: string;
  statusLabel: string;
};

export default function VehicleHeader({
  diagnosticCase,
  elapsedLabel,
  statusLabel,
}: VehicleHeaderProps) {
  const [open, setOpen] = useState(false);
  const v = diagnosticCase.extracted?.vehicle;
  const dtcs = diagnosticCase.extracted?.dtcs ?? [];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="surface-2 anim-in flex w-full items-start justify-between gap-3 p-4 text-left transition hover:border-[var(--border-strong)]"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
              {vehicleMake(diagnosticCase)}{" "}
              <span className="font-medium text-[var(--muted-strong)]">
                {v?.model ?? ""}
              </span>
            </h1>
            <span className="rounded-full border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--accent)]">
              AKTIVAN SLUČAJ
            </span>
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {vehicleSubtitle(diagnosticCase)}
            {elapsedLabel ? ` · ${elapsedLabel}` : ""}
          </p>
          <p className="mt-3 text-xs text-[var(--muted)]">Prijavljeni kvar</p>
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-[var(--muted-strong)]">
            {diagnosticCase.problemText}
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
              <span className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)]">
                {statusLabel}
              </span>
            </div>
          )}
        </div>
        <span className="text-[var(--muted)]" aria-hidden>
          •••
        </span>
      </button>

      <ResponsiveOverlay
        open={open}
        onClose={() => setOpen(false)}
        title="Detalji vozila"
      >
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Field label="Marka" value={v?.make} />
          <Field label="Model" value={v?.model} />
          <Field label="Godina" value={v?.year?.toString()} />
          <Field label="Motor" value={v?.engine} />
          <Field label="Kilometraža" value={v?.mileage ? `${v.mileage} km` : undefined} />
          <Field label="VIN" value={undefined} hint="Uskoro" />
          <Field
            label="DTC"
            value={dtcs.length ? dtcs.join(", ") : "Nema DTC"}
            mono
          />
          <div className="sm:col-span-2">
            <Field label="Bilješke / complaint" value={diagnosticCase.problemText} />
          </div>
        </dl>
      </ResponsiveOverlay>
    </>
  );
}

function Field({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value?: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd
        className={`mt-1 ${mono ? "mono-data" : ""} ${
          value ? "text-[var(--foreground)]" : "text-[var(--muted)]"
        }`}
      >
        {value ?? hint ?? "—"}
      </dd>
    </div>
  );
}
